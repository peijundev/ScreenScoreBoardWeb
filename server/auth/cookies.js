'use strict';
// Cookie 解析/序列化与 Secure 判定
const { config } = require('../config');
const { effectiveProtocol } = require('../security');

const SESSION_COOKIE = 'ssb_session';
const CSRF_COOKIE = 'ssb_csrf';

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || out[name] !== undefined) continue;
    out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

function cookieSecure(req) {
  const mode = config.auth.cookieSecure;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return effectiveProtocol(req) === 'https';
}

function serializeCookie(name, value, opts = {}) {
  const parts = [name + '=' + value, 'Path=' + (opts.path || '/'), 'SameSite=Lax'];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge != null) parts.push('Max-Age=' + Math.max(0, Math.floor(opts.maxAge)));
  return parts.join('; ');
}

function setSessionCookies(res, { token, csrfToken, maxAge, secure }) {
  const session = serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    maxAge,
  });
  const csrf = serializeCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    maxAge,
  });
  res.setHeader('Set-Cookie', [session, csrf]);
}

function clearSessionCookies(res, secure) {
  const session = serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure, maxAge: 0 });
  const csrf = serializeCookie(CSRF_COOKIE, '', { httpOnly: false, secure, maxAge: 0 });
  res.setHeader('Set-Cookie', [session, csrf]);
}

function readSessionToken(req) {
  return parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE] || '';
}

function readCsrfToken(req) {
  return parseCookies(req.headers && req.headers.cookie)[CSRF_COOKIE] || '';
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  parseCookies,
  cookieSecure,
  serializeCookie,
  setSessionCookies,
  clearSessionCookies,
  readSessionToken,
  readCsrfToken,
};
