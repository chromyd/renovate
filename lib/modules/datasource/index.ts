import is from '@sindresorhus/is';
import { dequal } from 'dequal';
import { GlobalConfig } from '../../config/global';
import { HOST_DISABLED } from '../../constants/error-messages';
import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import { coerceArray } from '../../util/array';
import * as memCache from '../../util/cache/memory';
import * as packageCache from '../../util/cache/package';
import type { PackageCacheNamespace } from '../../util/cache/package/types';
import { clone } from '../../util/clone';
import { filterMap } from '../../util/filter-map';
import { AsyncResult, Result } from '../../util/result';
import { DatasourceCacheStats } from '../../util/stats';
import { trimTrailingSlash } from '../../util/url';
import * as versioning from '../versioning';
import datasources from './api';
import {
  applyConstraintsFiltering,
  applyExtractVersion,
  applyVersionCompatibility,
  filterValidVersions,
  getDatasourceFor,
  sortAndRemoveDuplicates,
} from './common';
import { addMetaData } from './metadata';
import { setNpmrc } from './npm';
import { resolveRegistryUrl } from './npm/npmrc';
import type {
  DatasourceApi,
  DigestConfig,
  GetDigestInputConfig,
  GetPkgReleasesConfig,
  GetReleasesConfig,
  ReleaseResult,
} from './types';

export * from './types';
export { isGetPkgReleasesConfig } from './common';

export const getDatasources = (): Map<string, DatasourceApi> => datasources;
export const getDatasourceList = (): string[] => Array.from(datasources.keys());

type GetReleasesInternalConfig = GetReleasesConfig & GetPkgReleasesConfig;

// TODO: fix error Type
function logError(datasource: string, packageName: string, err: any): void {
  const { statusCode, code: errCode, url } = err;
  if (statusCode === 404) {
    logger.debug({ datasource, packageName, url }, 'Datasource 404');
  } else if (statusCode === 401 || statusCode === 403) {
    logger.debug({ datasource, packageName, url }, 'Datasource unauthorized');
  } else if (errCode) {
    logger.debug(
      { datasource, packageName, url, errCode },
      'Datasource connection error',
    );
  } else {
    logger.debug({ datasource, packageName, err }, 'Datasource unknown error');
  }
}

async function getRegistryReleases(
  datasource: DatasourceApi,
  config: GetReleasesConfig,
  registryUrl: string,
): Promise<ReleaseResult | null> {
  const cacheNamespace: PackageCacheNamespace = `datasource-releases-${datasource.id}`;
  const cacheKey = `${registryUrl}:${config.packageName}`;

  const cacheEnabled = !!datasource.caching; // tells if `isPrivate` flag is supported in datasource result
  const cacheForced = GlobalConfig.get('cachePrivatePackages', false); // tells if caching is forced via admin config

  if (cacheEnabled || cacheForced) {
    const cachedResult = await packageCache.get<ReleaseResult>(
      cacheNamespace,
      cacheKey,
    );

    if (cachedResult) {
      logger.trace({ cacheKey }, 'Returning cached datasource response');
      DatasourceCacheStats.hit(datasource.id, registryUrl, config.packageName);
      return cachedResult;
    }

    DatasourceCacheStats.miss(datasource.id, registryUrl, config.packageName);
  }

  const res = await datasource.getReleases({ ...config, registryUrl });
  if (res?.releases.length) {
    res.registryUrl ??= registryUrl;
  }

  if (!res) {
    return null;
  }

  let cache = false;
  if (cacheForced) {
    cache = true;
  } else if (cacheEnabled && !res.isPrivate) {
    cache = true;
  }

  if (cache) {
    logger.trace({ cacheKey }, 'Caching datasource response');
    await packageCache.set(cacheNamespace, cacheKey, res, 15);
    DatasourceCacheStats.set(datasource.id, registryUrl, config.packageName);
  } else {
    DatasourceCacheStats.skip(datasource.id, registryUrl, config.packageName);
  }

  return res;
}

function firstRegistry(
  config: GetReleasesInternalConfig,
  datasource: DatasourceApi,
  registryUrls: string[],
): Promise<ReleaseResult | null> {
  if (registryUrls.length > 1) {
    logger.warn(
      {
        datasource: datasource.id,
        packageName: config.packageName,
        registryUrls,
      },
      'Excess registryUrls found for datasource lookup - using first configured only',
    );
  }
  const registryUrl = registryUrls[0];
  return getRegistryReleases(datasource, config, registryUrl);
}

async function huntRegistries(
  config: GetReleasesInternalConfig,
  datasource: DatasourceApi,
  registryUrls: string[],
): Promise<ReleaseResult | null> {
  let res: ReleaseResult | null = null;
  let caughtError: Error | undefined;
  for (const registryUrl of registryUrls) {
    try {
      res = await getRegistryReleases(datasource, config, registryUrl);
      if (res) {
        break;
      }
    } catch (err) {
      if (err instanceof ExternalHostError) {
        throw err;
      }
      // We'll always save the last-thrown error
      caughtError = err;
      logger.trace({ err }, 'datasource hunt failure');
    }
  }
  if (res) {
    return res;
  }
  if (caughtError) {
    throw caughtError;
  }
  return null;
}

async function mergeRegistries(
  config: GetReleasesInternalConfig,
  datasource: DatasourceApi,
  registryUrls: string[],
): Promise<ReleaseResult | null> {
  let combinedRes: ReleaseResult | undefined;
  let lastErr: Error | undefined;
  let singleRegistry = true;
  const releaseVersioning = versioning.get(config.versioning);
  for (const registryUrl of registryUrls) {
    try {
      const res = await getRegistryReleases(datasource, config, registryUrl);
      if (!res) {
        continue;
      }

      if (!combinedRes) {
        // This is the first registry, so we can just use it and continue
        combinedRes = res;
        continue;
      }

      if (singleRegistry) {
        // This is the second registry
        // We need to move the registryUrl from the package level to the release level
        for (const release of coerceArray(combinedRes.releases)) {
          release.registryUrl ??= combinedRes.registryUrl;
        }
        singleRegistry = false;
      }

      const releases = coerceArray(res.releases);
      for (const release of releases) {
        // We have more than one registry, so we need to move the registryUrl
        // from the package level to the release level before merging
        release.registryUrl ??= res.registryUrl;
      }

      combinedRes.releases.push(...releases);

      // Merge the tags from the two results
      let tags = combinedRes.tags;
      if (tags) {
        if (res.tags) {
          // Both results had tags, so we need to compare them
          for (const tag of ['release', 'latest']) {
            const existingTag = combinedRes?.tags?.[tag];
            const newTag = res.tags?.[tag];
            if (is.string(newTag) && releaseVersioning.isVersion(newTag)) {
              if (
                is.string(existingTag) &&
                releaseVersioning.isVersion(existingTag)
              ) {
                // We need to compare them
                if (releaseVersioning.isGreaterThan(newTag, existingTag)) {
                  // New tag is greater than the existing one
                  tags[tag] = newTag;
                }
              } else {
                // Existing tag was not present or not a version
                // so we can just use the new one
                tags[tag] = newTag;
              }
            }
          }
        }
      } else {
        // Existing results had no tags, so we can just use the new ones
        tags = res.tags;
      }
      combinedRes = { ...res, ...combinedRes };
      if (tags) {
        combinedRes.tags = tags;
      }
      // Remove the registryUrl from the package level when more than one registry
      delete combinedRes.registryUrl;
    } catch (err) {
      if (err instanceof ExternalHostError) {
        throw err;
      }

      lastErr = err;
      logger.trace({ err }, 'datasource merge failure');
    }
  }

  if (!combinedRes) {
    if (lastErr) {
      throw lastErr;
    }

    return null;
  }

  const seenVersions = new Set<string>();
  combinedRes.releases = filterMap(combinedRes.releases, (release) => {
    if (seenVersions.has(release.version)) {
      return null;
    }
    seenVersions.add(release.version);
    return release;
  });

  return combinedRes;
}

function massageRegistryUrls(registryUrls: string[]): string[] {
  return registryUrls.filter(Boolean).map(trimTrailingSlash);
}

function resolveRegistryUrls(
  datasource: DatasourceApi,
  defaultRegistryUrls: string[] | undefined,
  registryUrls: string[] | undefined | null,
  additionalRegistryUrls: string[] | undefined,
): string[] {
  if (!datasource.customRegistrySupport) {
    if (
      is.nonEmptyArray(registryUrls) ||
      is.nonEmptyArray(defaultRegistryUrls) ||
      is.nonEmptyArray(additionalRegistryUrls)
    ) {
      logger.warn(
        {
          datasource: datasource.id,
          registryUrls,
          defaultRegistryUrls,
          additionalRegistryUrls,
        },
        'Custom registries are not allowed for this datasource and will be ignored',
      );
    }
    return is.function(datasource.defaultRegistryUrls)
      ? datasource.defaultRegistryUrls()
      : (datasource.defaultRegistryUrls ?? []);
  }
  const customUrls = registryUrls?.filter(Boolean);
  let resolvedUrls: string[] = [];
  if (is.nonEmptyArray(customUrls)) {
    resolvedUrls = [...customUrls];
  } else if (is.nonEmptyArray(defaultRegistryUrls)) {
    resolvedUrls = [...defaultRegistryUrls];
    resolvedUrls = resolvedUrls.concat(additionalRegistryUrls ?? []);
  } else if (is.function(datasource.defaultRegistryUrls)) {
    resolvedUrls = [...datasource.defaultRegistryUrls()];
    resolvedUrls = resolvedUrls.concat(additionalRegistryUrls ?? []);
  } else if (is.nonEmptyArray(datasource.defaultRegistryUrls)) {
    resolvedUrls = [...datasource.defaultRegistryUrls];
    resolvedUrls = resolvedUrls.concat(additionalRegistryUrls ?? []);
  }
  return massageRegistryUrls(resolvedUrls);
}

function applyReplacements(
  config: GetReleasesInternalConfig,
): Pick<ReleaseResult, 'replacementName' | 'replacementVersion'> | undefined {
  if (config.replacementName && config.replacementVersion) {
    return {
      replacementName: config.replacementName,
      replacementVersion: config.replacementVersion,
    };
  }
  return undefined;
}

async function fetchReleases(
  config: GetReleasesInternalConfig,
): Promise<ReleaseResult | null> {
  const { datasource: datasourceName } = config;
  let { registryUrls } = config;
  // istanbul ignore if: need test
  if (!datasourceName || getDatasourceFor(datasourceName) === undefined) {
    logger.warn({ datasource: datasourceName }, 'Unknown datasource');
    return null;
  }
  if (datasourceName === 'npm') {
    if (is.string(config.npmrc)) {
      setNpmrc(config.npmrc);
    }
    if (!is.nonEmptyArray(registryUrls)) {
      registryUrls = [resolveRegistryUrl(config.packageName)];
    }
  }
  const datasource = getDatasourceFor(datasourceName);
  // istanbul ignore if: needs test
  if (!datasource) {
    logger.warn({ datasource: datasourceName }, 'Unknown datasource');
    return null;
  }
  registryUrls = resolveRegistryUrls(
    datasource,
    config.defaultRegistryUrls,
    registryUrls,
    config.additionalRegistryUrls,
  );
  let dep: ReleaseResult | null = null;
  const registryStrategy =
    config.registryStrategy ?? datasource.registryStrategy ?? 'hunt';
  try {
    if (is.nonEmptyArray(registryUrls)) {
      if (registryStrategy === 'first') {
        dep = await firstRegistry(config, datasource, registryUrls);
      } else if (registryStrategy === 'hunt') {
        dep = await huntRegistries(config, datasource, registryUrls);
      } else if (registryStrategy === 'merge') {
        dep = await mergeRegistries(config, datasource, registryUrls);
      }
    } else {
      dep = await datasource.getReleases(config);
    }
  } catch (err) {
    if (err.message === HOST_DISABLED || err.err?.message === HOST_DISABLED) {
      return null;
    }
    if (err instanceof ExternalHostError) {
      throw err;
    }
    logError(datasource.id, config.packageName, err);
  }
  if (!dep || dequal(dep, { releases: [] })) {
    return null;
  }
  addMetaData(dep, datasourceName, config.packageName);
  dep = { ...dep, ...applyReplacements(config) };
  return dep;
}

function fetchCachedReleases(
  config: GetReleasesInternalConfig,
): Promise<ReleaseResult | null> {
  const { datasource, packageName, registryUrls } = config;
  const cacheKey = `datasource-mem:releases:${datasource}:${packageName}:${config.registryStrategy}:${String(
    registryUrls,
  )}`;
  // By returning a Promise and reusing it, we should only fetch each package at most once
  const cachedResult = memCache.get<Promise<ReleaseResult | null>>(cacheKey);
  // istanbul ignore if
  if (cachedResult !== undefined) {
    return cachedResult;
  }
  const promisedRes = fetchReleases(config);
  memCache.set(cacheKey, promisedRes);
  return promisedRes;
}

export function getRawPkgReleases(
  config: GetPkgReleasesConfig,
): AsyncResult<
  ReleaseResult,
  Error | 'no-datasource' | 'no-package-name' | 'no-result'
> {
  if (!config.datasource) {
    logger.warn('No datasource found');
    return AsyncResult.err('no-datasource');
  }

  const packageName = config.packageName;
  if (!packageName) {
    logger.error({ config }, 'Datasource getReleases without packageName');
    return AsyncResult.err('no-package-name');
  }

  return Result.wrapNullable(fetchCachedReleases(config), 'no-result' as const)
    .catch((e) => {
      if (e instanceof ExternalHostError) {
        e.hostType = config.datasource;
        e.packageName = packageName;
      }
      return Result.err(e);
    })
    .transform(clone);
}

export function applyDatasourceFilters(
  releaseResult: ReleaseResult,
  config: GetPkgReleasesConfig,
): ReleaseResult {
  let res = releaseResult;
  res = applyExtractVersion(res, config.extractVersion);
  res = applyVersionCompatibility(
    res,
    config.versionCompatibility,
    config.currentCompatibility,
  );
  res = filterValidVersions(res, config);
  res = sortAndRemoveDuplicates(res, config);
  res = applyConstraintsFiltering(res, config);
  return res;
}

export async function getPkgReleases(
  config: GetPkgReleasesConfig,
): Promise<ReleaseResult | null> {
  const { val = null, err } = await getRawPkgReleases(config)
    .transform((res) => applyDatasourceFilters(res, config))
    .unwrap();

  if (err instanceof Error) {
    throw err;
  }

  return val;
}

export function supportsDigests(datasource: string | undefined): boolean {
  const ds = !!datasource && getDatasourceFor(datasource);
  return !!ds && 'getDigest' in ds;
}

function getDigestConfig(
  datasource: DatasourceApi,
  config: GetDigestInputConfig,
): DigestConfig {
  const { lookupName, currentValue, currentDigest } = config;
  const packageName = config.replacementName ?? config.packageName;
  // Prefer registryUrl from getReleases() lookup if it has been passed
  const registryUrl =
    config.registryUrl ??
    resolveRegistryUrls(
      datasource,
      config.defaultRegistryUrls,
      config.registryUrls,
      config.additionalRegistryUrls,
    )[0];
  return { lookupName, packageName, registryUrl, currentValue, currentDigest };
}

export function getDigest(
  config: GetDigestInputConfig,
  value?: string,
): Promise<string | null> {
  const datasource = getDatasourceFor(config.datasource);
  // istanbul ignore if: need test
  if (!datasource || !('getDigest' in datasource)) {
    return Promise.resolve(null);
  }
  const digestConfig = getDigestConfig(datasource, config);
  return datasource.getDigest!(digestConfig, value);
}

export function getDefaultConfig(
  datasource: string,
): Promise<Record<string, unknown>> {
  const loadedDatasource = getDatasourceFor(datasource);
  return Promise.resolve<Record<string, unknown>>(
    loadedDatasource?.defaultConfig ?? Object.create({}),
  );
}
