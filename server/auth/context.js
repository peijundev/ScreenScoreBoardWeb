'use strict';
// 请求级 actor 上下文：让 commit()/applyOp() 不必逐个改调用点
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const SYSTEM = Object.freeze({ kind: 'system', role: 'system' });
const ANONYMOUS = Object.freeze({ kind: 'anonymous', role: 'anonymous' });

function runAs(actor, fn) {
  return als.run({ actor: actor || ANONYMOUS }, fn);
}

function currentActor() {
  const store = als.getStore();
  return store ? store.actor : null;
}

module.exports = { SYSTEM, ANONYMOUS, runAs, currentActor };
