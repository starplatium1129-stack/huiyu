import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ParamsDictionary } from 'express-serve-static-core'
import type { ParsedQs } from 'qs'

/**
 * Bind the request body/query/params types at a route boundary while keeping
 * Express' runtime middleware contract unchanged. Runtime validation remains
 * the responsibility of the route/service; this helper only prevents DTO
 * drift inside a handler.
 */
export function typedHandler<Body = unknown, Query extends ParsedQs = ParsedQs, Params extends ParamsDictionary = ParamsDictionary>(
  handler: (req: Request<Params, unknown, Body, Query>, res: Response, next: NextFunction) => unknown,
): RequestHandler<Params, unknown, Body, Query> {
  return handler as RequestHandler<Params, unknown, Body, Query>
}
