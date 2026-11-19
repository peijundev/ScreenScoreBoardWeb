'use strict';
// 极简路由匹配：支持 /:param 与末尾通配，不引入第三方依赖

function compile(pathPattern) {
  const keys = [];
  const source = pathPattern
    .split('/')
    .map((part) => {
      if (!part) return '';
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      if (part === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '/?$'), keys };
}

function createRouter(routes) {
  const compiled = routes.map((route) => ({ ...route, ...compile(route.path) }));
  return function match(method, pathname) {
    for (const route of compiled) {
      if (route.method !== method) continue;
      const found = route.regex.exec(pathname);
      if (!found) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(found[index + 1]);
      });
      return { route, params };
    }
    return null;
  };
}

module.exports = { createRouter };
