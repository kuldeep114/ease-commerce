import { ValidationError } from '../errors/app-error.js';

/**
 * Parses the body against a Zod schema and hands the *parsed* value to the controller as
 * `req.validated`. Controllers never read req.body, so defaults and coercions applied by the
 * schema are guaranteed to be the values the rest of the stack sees.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(ValidationError.fromZod(result.error));

    req.validated = result.data;
    return next();
  };
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
