'use strict';
// 旧版 /api/* 的统一访问守卫：未知路径默认 admin（fail closed）
const { legacyMinRole } = require('../auth/policy');
const { requireRole, requireOrigin, requireCsrf } = require('../auth/http');

function guardLegacy(req, res, pathname) {
  if (!requireOrigin(req, res)) return false;
  const minimum = legacyMinRole(req.method, pathname);
  if (!requireRole(req, res, minimum)) return false;
  if (!requireCsrf(req, res, pathname)) return false;
  return true;
}

module.exports = { guardLegacy };
