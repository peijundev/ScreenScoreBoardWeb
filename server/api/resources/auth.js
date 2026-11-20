'use strict';
// 鉴权、用户、会话、令牌的 REST v1 路由
const { handlers } = require('../../auth/http');

function authRoute(method, path, access, summary, handler) {
  return {
    method,
    path,
    access,
    mcp: false,
    summary,
    bodyLimit: 16 * 1024,
    handler,
  };
}

const routes = [
  authRoute('GET', '/auth/status', 'public', '登录状态与初始化状态', handlers.status),
  authRoute('POST', '/auth/setup', 'public', '首次初始化管理员', handlers.setup),
  authRoute('POST', '/auth/login', 'public', '登录', handlers.login),
  authRoute('POST', '/auth/logout', 'public', '退出登录', handlers.logout),

  authRoute('GET', '/auth/me', 'viewer', '当前用户', handlers.me),
  authRoute('POST', '/auth/password', 'viewer', '修改自己的密码', handlers.changePassword),
  authRoute('GET', '/auth/sessions', 'viewer', '自己的会话', handlers.listSessions),
  authRoute('DELETE', '/auth/sessions/:id', 'viewer', '吊销会话', handlers.revokeSession),
  authRoute('POST', '/auth/logout-all', 'viewer', '退出其他设备', handlers.logoutAll),
  authRoute('GET', '/auth/tokens', 'viewer', '自己的令牌', handlers.listTokens),
  authRoute('POST', '/auth/tokens', 'viewer', '创建自己的令牌', handlers.createToken),
  authRoute('DELETE', '/auth/tokens/:id', 'viewer', '吊销令牌', handlers.revokeToken),

  authRoute('GET', '/auth/users', 'admin', '用户列表', handlers.listUsers),
  authRoute('POST', '/auth/users', 'admin', '创建用户', handlers.createUser),
  authRoute('PATCH', '/auth/users/:id', 'admin', '更新用户', handlers.updateUser),
  authRoute('POST', '/auth/users/:id/password', 'admin', '重置用户密码', handlers.resetUserPassword),
  authRoute('DELETE', '/auth/users/:id', 'admin', '删除用户', handlers.deleteUser),
  authRoute('GET', '/auth/users/:id/sessions', 'admin', '用户会话', handlers.userSessions),
  authRoute(
    'DELETE',
    '/auth/users/:id/sessions/:sessionId',
    'admin',
    '吊销用户会话',
    handlers.revokeUserSession,
  ),
  authRoute('GET', '/auth/users/:id/tokens', 'admin', '用户令牌', handlers.userTokens),
  authRoute('POST', '/auth/users/:id/tokens', 'admin', '为用户创建令牌', handlers.createUserToken),
  authRoute(
    'DELETE',
    '/auth/users/:id/tokens/:tokenId',
    'admin',
    '吊销用户令牌',
    handlers.revokeUserToken,
  ),
];

module.exports = { routes };
