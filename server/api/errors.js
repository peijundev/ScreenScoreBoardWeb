'use strict';
// REST v1 错误类型与状态码映射（不依赖具体状态）
const {
  OpError,
  NotFoundError,
  FeatureDisabledError,
  UnauthorizedError,
  ForbiddenError,
} = require('../validation');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ApiNotFoundError extends ApiError {
  constructor(message, details) {
    super(404, 'NOT_FOUND', message, details);
  }
}

class ApiConflictError extends ApiError {
  constructor(message, details) {
    super(409, 'CONFLICT', message, details);
  }
}

class ApiPreconditionError extends ApiError {
  constructor(message, details) {
    super(428, 'PRECONDITION_REQUIRED', message, details);
  }
}

class ApiUnprocessableError extends ApiError {
  constructor(message, details) {
    super(422, 'UNPROCESSABLE', message, details);
  }
}

function isNotFound(error) {
  return Boolean(error) && (error instanceof NotFoundError ||
    error.name === 'NotFoundError' || error.code === 'NOT_FOUND');
}

function toApiError(error) {
  if (error instanceof ApiError) return error;
  const message = error && error.message ? String(error.message) : '服务器内部错误';
  // 子类必须先于 OpError 判断：NotFound / FeatureDisabled 都继承自 OpError
  if (isNotFound(error)) return new ApiError(404, 'NOT_FOUND', message);
  if (error instanceof UnauthorizedError || (error && error.name === 'UnauthorizedError')) {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  if (error instanceof ForbiddenError || (error && error.name === 'ForbiddenError')) {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  if (error instanceof FeatureDisabledError || (error && error.name === 'FeatureDisabledError')) {
    return new ApiError(403, 'FEATURE_DISABLED', message);
  }
  if (error && error.name === 'UserInputError') {
    return new ApiError(400, 'INVALID_ARGUMENT', message);
  }
  if (error && error.name === 'PasswordPolicyError') {
    return new ApiError(422, 'WEAK_PASSWORD', message);
  }
  if (error && error.name === 'PayloadTooLargeError') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
  }
  if (error && error.name === 'SyntaxError') {
    return new ApiError(400, 'MALFORMED_JSON', '请求体不是合法 JSON');
  }
  if (error && error.name === 'StorageConfigError') {
    return new ApiError(422, error.code || 'STORAGE_CONFIG_INVALID', message, error.details);
  }
  if (error && error.name === 'StorageConflictError') {
    return new ApiError(409, 'STORAGE_CONFLICT', message, error.details);
  }
  if (error && error.name === 'StorageDriverMissingError') {
    return new ApiError(422, 'STORAGE_DRIVER_MISSING', message, error.details);
  }
  if (error && error.name === 'StorageUnsupportedError') {
    return new ApiError(422, 'STORAGE_UNSUPPORTED', message, error.details);
  }
  if (error instanceof OpError || (error && error.name === 'OpError')) {
    // 上限类错误语义上更接近 422，但仍保持稳定的 400 兼容旧客户端断言
    return new ApiError(400, 'INVALID_ARGUMENT', message);
  }
  return new ApiError(500, 'INTERNAL', '服务器内部错误');
}

module.exports = {
  ApiError,
  ApiNotFoundError,
  ApiConflictError,
  ApiPreconditionError,
  ApiUnprocessableError,
  toApiError,
};
