import type { XmlDocument } from 'xmldoc';
import { logger } from '../../../logger';
import * as packageCache from '../../../util/cache/package';
import { asTimestamp } from '../../../util/timestamp';
import { ensureTrailingSlash } from '../../../util/url';
import mavenVersion from '../../versioning/maven';
import * as mavenVersioning from '../../versioning/maven';
import { compare } from '../../versioning/maven/compare';
import { Datasource } from '../datasource';
import type {
  GetReleasesConfig,
  PostprocessReleaseConfig,
  PostprocessReleaseResult,
  RegistryStrategy,
  Release,
  ReleaseResult,
} from '../types';
import { MAVEN_REPO } from './common';
import type { MavenDependency, MetadataResults } from './types';
import {
  createUrlForDependencyPom,
  downloadMaven,
  downloadMavenXml,
  getDependencyInfo,
  getDependencyParts,
  getMavenUrl,
} from './util';

function getLatestSuitableVersion(releases: Release[]): string | null {
  /* v8 ignore next 3 -- TODO: add test */
  if (!releases?.length) {
    return null;
  }
  const allVersions = releases.map(({ version }) => version);
  const stableVersions = allVersions.filter((x) => mavenVersion.isStable(x));
  const versions = stableVersions.length ? stableVersions : allVersions;
  return versions.reduce((latestVersion, version) =>
    compare(version, latestVersion) === 1
      ? version
      : /* istanbul ignore next: hard to test */ latestVersion,
  );
}

function extractVersions(metadata: XmlDocument): MetadataResults {
  const res: MetadataResults = {};
  const versions = metadata.descendantWithPath('versioning.versions');
  const elements = versions?.childrenNamed('version');
  if (!elements) {
    return res;
  }
  res.versions = elements.map((el) => el.val);

  return res;
}

export const defaultRegistryUrls = [MAVEN_REPO];

export class MavenDatasource extends Datasource {
  static id = 'maven';

  override readonly caching = true;

  override readonly defaultRegistryUrls = defaultRegistryUrls;

  override readonly defaultVersioning: string = mavenVersioning.id;

  override readonly registryStrategy: RegistryStrategy = 'merge';

  override readonly releaseTimestampSupport = true;
  override readonly releaseTimestampNote =
    'The release timestamp is determined from the `Last-Modified` header or the `lastModified` field in the results.';
  override readonly sourceUrlSupport = 'package';
  override readonly sourceUrlNote =
    'The source URL is determined from the `scm` tags in the results.';

  constructor(id = MavenDatasource.id) {
    super(id);
  }

  async fetchVersionsFromMetadata(
    dependency: MavenDependency,
    repoUrl: string,
  ): Promise<MetadataResults> {
    const metadataUrl = getMavenUrl(dependency, repoUrl, 'maven-metadata.xml');
    const metadataXmlResult = await downloadMavenXml(this.http, metadataUrl);
    return metadataXmlResult
      .transform(({ data: metadata }) => extractVersions(metadata))
      .onError((err) => {
        logger.debug(
          `Maven: error fetching versions for "${dependency.display}": ${err.type}`,
        );
      })
      .unwrapOr({});
  }

  async getReleases({
    packageName,
    registryUrl,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    /* v8 ignore next 3 -- should never happen */
    if (!registryUrl) {
      return null;
    }

    const dependency = getDependencyParts(packageName);
    const repoUrl = ensureTrailingSlash(registryUrl);

    logger.debug(`Looking up ${dependency.display} in repository ${repoUrl}`);

    const metadata = await this.fetchVersionsFromMetadata(dependency, repoUrl);
    if (!metadata.versions?.length) {
      return null;
    }
    const releases = metadata.versions.map((version) => ({ version }));

    logger.debug(
      `Found ${releases.length} new releases for ${dependency.display} in repository ${repoUrl}`,
    );

    const latestSuitableVersion = getLatestSuitableVersion(releases);
    const dependencyInfo =
      latestSuitableVersion &&
      (await getDependencyInfo(
        this.http,
        dependency,
        repoUrl,
        latestSuitableVersion,
      ));

    const result: ReleaseResult = {
      ...dependency,
      ...dependencyInfo,
      releases,
    };
    if (metadata.tags) {
      result.tags = metadata.tags;
    }

    if (!this.defaultRegistryUrls.includes(registryUrl)) {
      result.isPrivate = true;
    }

    return result;
  }

  override async postprocessRelease(
    { packageName, registryUrl }: PostprocessReleaseConfig,
    release: Release,
  ): Promise<PostprocessReleaseResult> {
    const { version, versionOrig } = release;
    const cacheKey = versionOrig
      ? `postprocessRelease:${registryUrl}:${packageName}:${versionOrig}:${version}`
      : `postprocessRelease:${registryUrl}:${packageName}:${version}`;
    const cachedResult = await packageCache.get<PostprocessReleaseResult>(
      'datasource-maven:postprocess-reject',
      cacheKey,
    );

    /* v8 ignore start: hard to test */
    if (cachedResult) {
      return cachedResult;
    } /* v8 ignore stop */

    if (!packageName || !registryUrl) {
      return release;
    }

    const dependency = getDependencyParts(packageName);

    const pomUrl = await createUrlForDependencyPom(
      this.http,
      release.versionOrig ?? release.version,
      dependency,
      registryUrl,
    );

    const artifactUrl = getMavenUrl(dependency, registryUrl, pomUrl);
    const fetchResult = await downloadMaven(this.http, artifactUrl);
    const { val, err } = fetchResult.unwrap();

    if (err) {
      const result: PostprocessReleaseResult =
        err.type === 'not-found' ? 'reject' : release;
      if (result === 'reject') {
        await packageCache.set(
          'datasource-maven:postprocess-reject',
          cacheKey,
          result,
          24 * 60,
        );
      }
      return result;
    }

    if (val.lastModified) {
      release.releaseTimestamp = asTimestamp(val.lastModified);
    }

    return release;
  }
}
