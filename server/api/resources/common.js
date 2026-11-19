'use strict';
const { state, applyOp, save } = require('../../state');
const { broadcastState } = require('../../wss');
const { ApiNotFoundError } = require('../errors');

/** 所有 REST 写操作的唯一出口：applyOp → 落盘 → 广播 */
function commit(op, payload) {
  const result = applyOp(op, payload);
  save();
  broadcastState();
  return result;
}

function requireProject(projectId) {
  const project = state.projects[projectId];
  if (!project) throw new ApiNotFoundError('项目不存在');
  return project;
}

function requirePerson(project, personId) {
  const person = project.people[personId];
  if (!person) throw new ApiNotFoundError('人员不存在');
  return person;
}

function requireTeam(project, teamId) {
  const team = project.teams[teamId];
  if (!team) throw new ApiNotFoundError('团队不存在');
  return team;
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    people: Object.keys(project.people).length,
    teams: Object.keys(project.teams).length,
    themeId: project.themeId || null,
    themeRevision: project.themeRevision || 0,
  };
}

function projectDetail(project) {
  return {
    ...project,
    peopleCount: Object.keys(project.people).length,
    teamsCount: Object.keys(project.teams).length,
  };
}

function listOf(map) {
  return Object.values(map || {});
}

function parseRevision(ctx) {
  const header = ctx.req.headers['if-match'];
  let raw = null;
  if (typeof header === 'string' && header.trim()) {
    // 支持 W/"3"、ETag 列表与 If-Match: *（HTTP 语义：匹配任意当前版本）
    raw = header.trim().split(',')[0].trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    if (raw === '*') return '*';
  } else if (ctx.query && ctx.query.revision != null) {
    raw = ctx.query.revision;
    if (raw === '*') return '*';
  }
  if (raw == null || raw === '') return null;
  const revision = Number(raw);
  return Number.isFinite(revision) ? Math.trunc(revision) : null;
}

module.exports = {
  commit,
  requireProject,
  requirePerson,
  requireTeam,
  projectSummary,
  projectDetail,
  listOf,
  parseRevision,
};
