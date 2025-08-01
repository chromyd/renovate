import { Stream } from 'node:stream';
import is from '@sindresorhus/is';
import bunyan from 'bunyan';
import fs from 'fs-extra';
import { RequestError as HttpError } from 'got';
import { ZodError } from 'zod';
import { regEx } from '../util/regex';
import { redactedFields, sanitize } from '../util/sanitize';
import type { BunyanRecord, BunyanStream } from './types';

const excludeProps = ['pid', 'time', 'v', 'hostname'];

export class ProblemStream extends Stream {
  private _problems: BunyanRecord[] = [];

  readable: boolean;

  writable: boolean;

  constructor() {
    super();
    this.readable = false;
    this.writable = true;
  }

  write(data: BunyanRecord): boolean {
    const problem = { ...data };
    for (const prop of excludeProps) {
      delete problem[prop];
    }
    this._problems.push(problem);
    return true;
  }

  getProblems(): BunyanRecord[] {
    return this._problems;
  }

  clearProblems(): void {
    this._problems = [];
  }
}

const contentFields = [
  'content',
  'contents',
  'packageLockParsed',
  'yarnLockParsed',
];

type ZodShortenedIssue =
  | null
  | string
  | string[]
  | {
      [key: string]: ZodShortenedIssue;
    };

export function prepareZodIssues(input: unknown): ZodShortenedIssue {
  if (!is.plainObject(input)) {
    return null;
  }

  let err: null | string | string[] = null;
  if (is.array(input._errors, is.string)) {
    if (input._errors.length === 1) {
      err = input._errors[0];
    } else if (input._errors.length > 1) {
      err = input._errors;
    } else {
      err = null;
    }
  }
  delete input._errors;

  if (is.emptyObject(input)) {
    return err;
  }

  const output: Record<string, ZodShortenedIssue> = {};
  const entries = Object.entries(input);
  for (const [key, value] of entries.slice(0, 3)) {
    const child = prepareZodIssues(value);
    if (child !== null) {
      output[key] = child;
    }
  }

  if (entries.length > 3) {
    output.___ = `... ${entries.length - 3} more`;
  }

  return output;
}

export function prepareZodError(err: ZodError): Record<string, unknown> {
  Object.defineProperty(err, 'message', {
    get: () => 'Schema error',
    /* v8 ignore next 3 -- TODO: drop set? */
    set: () => {
      /* intentionally empty */
    },
  });

  return {
    message: err.message,
    stack: err.stack,
    issues: prepareZodIssues(err.format()),
  };
}

export default function prepareError(err: Error): Record<string, unknown> {
  if (err instanceof ZodError) {
    return prepareZodError(err);
  }

  const response: Record<string, unknown> = {
    ...err,
  };

  // Required as message is non-enumerable
  if (!response.message && err.message) {
    response.message = err.message;
  }

  // Required as stack is non-enumerable
  if (!response.stack && err.stack) {
    response.stack = err.stack;
  }

  if (err instanceof AggregateError) {
    response.errors = err.errors.map((error) => prepareError(error));
  }

  // handle got error
  if (err instanceof HttpError) {
    const options: Record<string, unknown> = {
      headers: structuredClone(err.options.headers),
      url: err.options.url?.toString(),
      hostType: err.options.context.hostType,
    };
    response.options = options;

    options.username = err.options.username;
    options.password = err.options.password;
    options.method = err.options.method;
    options.http2 = err.options.http2;

    if (err.response) {
      response.response = {
        statusCode: err.response.statusCode,
        statusMessage: err.response.statusMessage,
        body:
          err.name === 'TimeoutError'
            ? undefined
            : structuredClone(err.response.body),
        headers: structuredClone(err.response.headers),
        httpVersion: err.response.httpVersion,
        retryCount: err.response.retryCount,
      };
    }
  }

  return response;
}

type NestedValue = unknown[] | object;

function isNested(value: unknown): value is NestedValue {
  return is.array(value) || is.object(value);
}

export function sanitizeValue(
  value: unknown,
  seen = new WeakMap<NestedValue, unknown>(),
): any {
  if (is.string(value)) {
    return sanitize(sanitizeUrls(value));
  }

  if (is.date(value)) {
    return value;
  }

  if (is.function(value)) {
    return '[function]';
  }

  if (is.buffer(value)) {
    return '[content]';
  }

  if (is.error(value)) {
    const err = prepareError(value);
    return sanitizeValue(err, seen);
  }

  if (is.array(value)) {
    const length = value.length;
    const arrayResult = Array(length);
    seen.set(value, arrayResult);
    for (let idx = 0; idx < length; idx += 1) {
      const val = value[idx];
      arrayResult[idx] =
        isNested(val) && seen.has(val)
          ? seen.get(val)
          : sanitizeValue(val, seen);
    }
    return arrayResult;
  }

  if (is.object(value)) {
    const objectResult: Record<string, any> = {};
    seen.set(value, objectResult);
    for (const [key, val] of Object.entries<any>(value)) {
      let curValue: any;
      if (!val) {
        curValue = val;
      } else if (redactedFields.includes(key)) {
        // Do not mask/sanitize secrets templates
        if (is.string(val) && regEx(/^{{\s*secrets\..*}}$/).test(val)) {
          curValue = val;
        } else {
          curValue = '***********';
        }
      } else if (contentFields.includes(key)) {
        curValue = '[content]';
      } else if (key === 'secrets') {
        curValue = {};
        Object.keys(val).forEach((secretKey) => {
          curValue[secretKey] = '***********';
        });
      } else {
        curValue = seen.has(val) ? seen.get(val) : sanitizeValue(val, seen);
      }

      objectResult[key] = curValue;
    }

    return objectResult;
  }

  return value;
}

export function withSanitizer(streamConfig: bunyan.Stream): bunyan.Stream {
  if (streamConfig.type === 'rotating-file') {
    throw new Error("Rotating files aren't supported");
  }

  const stream = streamConfig.stream as BunyanStream;
  if (stream?.writable) {
    const write = (
      chunk: BunyanRecord,
      enc: BufferEncoding,
      cb: (err?: Error | null) => void,
    ): void => {
      const raw = sanitizeValue(chunk);
      const result =
        streamConfig.type === 'raw'
          ? raw
          : JSON.stringify(raw, bunyan.safeCycles()).replace(
              regEx(/\n?$/),
              '\n',
            );
      stream.write(result, enc, cb);
    };

    return {
      ...streamConfig,
      type: 'raw',
      stream: { write },
    } as bunyan.Stream;
  }

  if (streamConfig.path) {
    const fileStream = fs.createWriteStream(streamConfig.path, {
      flags: 'a',
      encoding: 'utf8',
    });

    return withSanitizer({ ...streamConfig, stream: fileStream });
  }

  throw new Error("Missing 'stream' or 'path' for bunyan stream");
}

/**
 * A function that terminates execution if the log level that was entered is
 *  not a valid value for the Bunyan logger.
 * @param logLevelToCheck
 * @returns returns the logLevel when the logLevelToCheck is valid or the defaultLevel passed as argument when it is undefined. Else it stops execution.
 */
export function validateLogLevel(
  logLevelToCheck: string | undefined,
  defaultLevel: bunyan.LogLevelString,
): bunyan.LogLevelString {
  const allowedValues: bunyan.LogLevelString[] = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ];

  if (
    is.undefined(logLevelToCheck) ||
    (is.string(logLevelToCheck) &&
      allowedValues.includes(logLevelToCheck as bunyan.LogLevelString))
  ) {
    // log level is in the allowed values or its undefined
    return (logLevelToCheck as bunyan.LogLevelString) ?? defaultLevel;
  }

  const logger = bunyan.createLogger({
    name: 'renovate',
    streams: [
      {
        level: 'fatal',
        stream: process.stdout,
      },
    ],
  });
  logger.fatal({ logLevel: logLevelToCheck }, 'Invalid log level');
  process.exit(1);
}

// Can't use `util/regex` because of circular reference to logger
const urlRe = /[a-z]{3,9}:\/\/[^@/]+@[a-z0-9.-]+/gi;
const urlCredRe = /\/\/[^@]+@/g;
const dataUriCredRe = /^(data:[0-9a-z-]+\/[0-9a-z-]+;).+/i;

export function sanitizeUrls(text: string): string {
  return text
    .replace(urlRe, (url) => {
      return url.replace(urlCredRe, '//**redacted**@');
    })
    .replace(dataUriCredRe, '$1**redacted**');
}

export function getEnv(key: string): string | undefined {
  return [process.env[`RENOVATE_${key}`], process.env[key]]
    .map((v) => v?.toLowerCase().trim())
    .find(is.nonEmptyStringAndNotWhitespace);
}

export function getMessage(
  p1: string | Record<string, any>,
  p2?: string,
): string | undefined {
  return is.string(p1) ? p1 : p2;
}

export function toMeta(
  p1: string | Record<string, any>,
): Record<string, unknown> {
  return is.object(p1) ? p1 : {};
}
