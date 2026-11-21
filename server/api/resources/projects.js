'use strict';
const { state } = require('../../state');
const { SETTINGS_VALIDATORS } = require('../../settings');
const runtime = require('../../runtime');
const { OPS } = require('../../ops');
const {
  commit, requireProject, requirePerson, requireTeam,
  projectSummary, projectDetail,
} = require('./common');
const { ApiUnprocessableError } = require('../errors');

function sorted(map) {
  return Object.values(map || {}).sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
}

function page(items, query) {
  const offset = Math.max(0, Number(query.offset) || 0);
  const rawLimit = Number(query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2000, Math.trunc(rawLimit)) : items.length;
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

function personOf(project, personId) {
  const person = requirePerson(project, personId);
  return { ...person, teamName: person.teamId && project.teams[person.teamId] ? project.teams[person.teamId].name : '' };
}

function teamOf(project, teamId) {
  const team = requireTeam(project, teamId);
  const members = Object.values(project.people)
    .filter((p) => p.teamId === team.id)
    .sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
  return {
    ...team,
    members,
    total: members.reduce((sum, p) => sum + p.score, 0),
  };
}

const routes = [
  // ---------- 项目 ----------
  {
    method: 'GET', path: '/projects', mcp: 'list_projects', summary: '列出所有项目',
    handler: () => ({ data: Object.values(state.projects).map(projectSummary) }),
  },
  {
    method: 'POST', path: '/projects', mcp: 'create_project', summary: '新建项目', mutates: true,
    handler: (ctx) => {
      const result = commit(OPS.addProject, { name: ctx.body.name });
      return { data: { ...result, project: projectSummary(requireProject(result.projectId)) }, status: 201 };
    },
  },
  {
    method: 'GET', path: '/projects/:projectId', mcp: 'get_project', summary: '读取项目详情与设置摘要',
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      return {
        data: {
          ...projectDetail(project),
          peopleList: sorted(project.people),
          teamsList: sorted(project.teams),
        },
      };
    },
  },
  {
    method: 'PATCH', path: '/projects/:projectId', mcp: 'rename_project', summary: '重命名项目', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.renameProject, { projectId: ctx.params.projectId, name: ctx.body.name });
      return { data: projectSummary(requireProject(ctx.params.projectId)) };
    },
  },
  {
    method: 'DELETE', path: '/projects/:projectId', mcp: 'delete_project', summary: '删除项目（至少保留一个）', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.deleteProject, { projectId: ctx.params.projectId });
      return { data: { deleted: ctx.params.projectId } };
    },
  },

  // ---------- 人员 ----------
  {
    method: 'GET', path: '/projects/:projectId/people', mcp: 'list_people', summary: '列出人员，可按姓名或团队过滤',
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim().toLowerCase() : '';
      const teamId = ctx.query.teamId || null;
      let items = sorted(project.people);
      if (q) items = items.filter((p) => p.name.toLowerCase().includes(q));
      if (teamId) items = items.filter((p) => p.teamId === teamId);
      return { data: page(items, ctx.query) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/people', mcp: 'add_person', summary: '新增人员', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.addPerson, {
        projectId: ctx.params.projectId,
        name: ctx.body.name,
        avatar: ctx.body.avatar,
        cardImage: ctx.body.cardImage,
        bio: ctx.body.bio,
        teamId: ctx.body.teamId,
      });
      return { data: personOf(requireProject(ctx.params.projectId), result.personId), status: 201 };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/people/batch', mcp: 'add_people_batch', summary: '批量新增人员（自动去重）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.addPeopleBatch, {
        projectId: ctx.params.projectId,
        names: ctx.body.names,
        teamId: ctx.body.teamId,
      });
      return { data: result, status: 201 };
    },
  },
  {
    method: 'GET', path: '/projects/:projectId/people/:personId', mcp: 'get_person', summary: '读取人员',
    handler: (ctx) => ({ data: personOf(requireProject(ctx.params.projectId), ctx.params.personId) }),
  },
  {
    method: 'PATCH', path: '/projects/:projectId/people/:personId', mcp: 'update_person', summary: '修改人员姓名/头像/简介/团队', mutates: true,
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      requirePerson(project, ctx.params.personId);
      commit(OPS.updatePerson, {
        projectId: project.id,
        personId: ctx.params.personId,
        name: ctx.body.name,
        avatar: ctx.body.avatar,
        cardImage: ctx.body.cardImage,
        bio: ctx.body.bio,
        teamId: ctx.body.teamId,
      });
      return { data: personOf(project, ctx.params.personId) };
    },
  },
  {
    method: 'DELETE', path: '/projects/:projectId/people/:personId', mcp: 'remove_person', summary: '删除人员', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.removePerson, { projectId: ctx.params.projectId, personId: ctx.params.personId });
      return { data: { deleted: ctx.params.personId } };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/people/:personId/move', mcp: 'move_person', summary: '上移/下移人员（自动切换自定义顺序）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.movePerson, {
        projectId: ctx.params.projectId,
        personId: ctx.params.personId,
        direction: ctx.body.direction,
      });
      return { data: result };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/bio', mcp: 'set_person_bio', summary: '设置人员简介', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setBio, {
        projectId: ctx.params.projectId, kind: 'person', id: ctx.params.personId, bio: ctx.body.bio,
      });
      return { data: result };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/avatar', mcp: 'set_person_avatar', summary: '设置人员头像（null 清除）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.setAvatar, {
        projectId: ctx.params.projectId, kind: 'person', id: ctx.params.personId, avatar: ctx.body.avatar,
      });
      return { data: personOf(requireProject(ctx.params.projectId), ctx.params.personId) };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/card-image', mcp: 'set_person_card_image', summary: '设置人员卡面（null 清除）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.setCardImage, {
        projectId: ctx.params.projectId, kind: 'person', id: ctx.params.personId, image: ctx.body.image,
      });
      return { data: personOf(requireProject(ctx.params.projectId), ctx.params.personId) };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/team', mcp: 'assign_team', summary: '设置人员所属团队（null 移出）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.assignTeam, {
        projectId: ctx.params.projectId, personId: ctx.params.personId, teamId: ctx.body.teamId,
      });
      return { data: personOf(requireProject(ctx.params.projectId), ctx.params.personId) };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/layout', mcp: 'set_person_layout', summary: '设置人员自由布局', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setLayout, {
        projectId: ctx.params.projectId, kind: 'person', id: ctx.params.personId, layout: ctx.body.layout,
      });
      return { data: result };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/people/:personId/member-layout', mcp: 'set_member_layout', summary: '设置成员小卡布局', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setMemberLayout, {
        projectId: ctx.params.projectId, personId: ctx.params.personId, layout: ctx.body.layout,
      });
      return { data: result };
    },
  },

  // ---------- 团队 ----------
  {
    method: 'GET', path: '/projects/:projectId/teams', mcp: 'list_teams', summary: '列出团队（含成员与总分）',
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      const teams = sorted(project.teams).map((team) => teamOf(project, team.id));
      return { data: page(teams, ctx.query) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/teams', mcp: 'add_team', summary: '新增团队', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.addTeam, {
        projectId: ctx.params.projectId,
        name: ctx.body.name,
        avatar: ctx.body.avatar,
        cardImage: ctx.body.cardImage,
        bio: ctx.body.bio,
      });
      return { data: teamOf(requireProject(ctx.params.projectId), result.teamId), status: 201 };
    },
  },
  {
    method: 'GET', path: '/projects/:projectId/teams/:teamId', mcp: 'get_team', summary: '读取团队与成员',
    handler: (ctx) => ({ data: teamOf(requireProject(ctx.params.projectId), ctx.params.teamId) }),
  },
  {
    method: 'PATCH', path: '/projects/:projectId/teams/:teamId', mcp: 'update_team', summary: '修改团队名称/头像/简介', mutates: true,
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      requireTeam(project, ctx.params.teamId);
      commit(OPS.updateTeam, {
        projectId: project.id,
        teamId: ctx.params.teamId,
        name: ctx.body.name,
        avatar: ctx.body.avatar,
        cardImage: ctx.body.cardImage,
        bio: ctx.body.bio,
      });
      return { data: teamOf(project, ctx.params.teamId) };
    },
  },
  {
    method: 'DELETE', path: '/projects/:projectId/teams/:teamId', mcp: 'remove_team', summary: '删除团队（成员自动移出）', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.removeTeam, { projectId: ctx.params.projectId, teamId: ctx.params.teamId });
      return { data: { deleted: ctx.params.teamId } };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/teams/:teamId/move', mcp: 'move_team', summary: '上移/下移团队（自动切换自定义顺序）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.moveTeam, {
        projectId: ctx.params.projectId, teamId: ctx.params.teamId, direction: ctx.body.direction,
      });
      return { data: result };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/teams/:teamId/bio', mcp: 'set_team_bio', summary: '设置团队简介', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setBio, {
        projectId: ctx.params.projectId, kind: 'team', id: ctx.params.teamId, bio: ctx.body.bio,
      });
      return { data: result };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/teams/:teamId/avatar', mcp: 'set_team_avatar', summary: '设置团队头像（null 清除）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.setAvatar, {
        projectId: ctx.params.projectId, kind: 'team', id: ctx.params.teamId, avatar: ctx.body.avatar,
      });
      return { data: teamOf(requireProject(ctx.params.projectId), ctx.params.teamId) };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/teams/:teamId/card-image', mcp: 'set_team_card_image', summary: '设置团队卡面（null 清除）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.setCardImage, {
        projectId: ctx.params.projectId, kind: 'team', id: ctx.params.teamId, image: ctx.body.image,
      });
      return { data: teamOf(requireProject(ctx.params.projectId), ctx.params.teamId) };
    },
  },
  {
    method: 'PUT', path: '/projects/:projectId/teams/:teamId/layout', mcp: 'set_team_layout', summary: '设置团队自由布局', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setLayout, {
        projectId: ctx.params.projectId, kind: 'team', id: ctx.params.teamId, layout: ctx.body.layout,
      });
      return { data: result };
    },
  },

  // ---------- 分数 ----------
  {
    method: 'POST', path: '/projects/:projectId/people/:personId/score/add', mcp: 'add_score', summary: '给人员加/减分', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.addScore, {
        projectId: ctx.params.projectId, personId: ctx.params.personId, delta: ctx.body.delta,
      });
      return { data: result };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/people/:personId/score/set', mcp: 'set_score', summary: '设置人员分数', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.setScore, {
        projectId: ctx.params.projectId, personId: ctx.params.personId, score: ctx.body.score,
      });
      return { data: result };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/teams/:teamId/score/add', mcp: 'add_team_score', summary: '团队全员加/减分', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.addTeamScore, {
        projectId: ctx.params.projectId, teamId: ctx.params.teamId, delta: ctx.body.delta,
      });
      return { data: result };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/scores/reset', mcp: 'reset_scores', summary: '重置本局全部分数', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.resetScores, { projectId: ctx.params.projectId });
      return { data: result };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/spotlight', mcp: 'trigger_spotlight', summary: '不改变分数，居中突显指定人员或团队', mutates: true,
    input: {
      type: 'object',
      required: ['targetType', 'targetId'],
      properties: {
        targetType: { type: 'string', enum: ['person', 'team'], description: '突显对象类型' },
        targetId: { type: 'string', description: '人员 ID 或团队 ID' },
        durationMs: {
          type: 'integer', minimum: 0, maximum: 10000,
          description: '本次突显总时长；省略或 0 时使用项目设置「手动突显时长」，再回退到突显主题时长',
        },
      },
      additionalProperties: false,
    },
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const result = commit(OPS.triggerSpotlight, {
        projectId: ctx.params.projectId,
        targetType: ctx.body.targetType,
        targetId: ctx.body.targetId,
        durationMs: ctx.body.durationMs,
      });
      return { data: result };
    },
  },

  // ---------- 设置 / 布局 ----------
  {
    method: 'GET', path: '/projects/:projectId/settings', mcp: 'get_settings', summary: '读取项目全部设置',
    handler: (ctx) => ({ data: requireProject(ctx.params.projectId).settings }),
  },
  {
    method: 'PATCH', path: '/projects/:projectId/settings', mcp: 'update_settings', summary: '批量修改设置（未知键返回 422）', mutates: true,
    handler: (ctx) => {
      const project = requireProject(ctx.params.projectId);
      const patch = ctx.body.patch !== undefined ? ctx.body.patch : ctx.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ApiUnprocessableError('设置补丁必须是对象');
      }
      const unknownKeys = Object.keys(patch).filter((key) => !SETTINGS_VALIDATORS[key]);
      if (unknownKeys.length) {
        throw new ApiUnprocessableError('包含未知的设置项', { unknownKeys });
      }
      commit(OPS.updateSettings, { projectId: project.id, patch });
      return { data: project.settings };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/layout/reset', mcp: 'reset_layout', summary: '清空全部自由布局', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.resetLayout, { projectId: ctx.params.projectId }) };
    },
  },

  // ---------- 运行时 ----------
  {
    method: 'GET', path: '/projects/:projectId/runtime', mcp: 'get_runtime', summary: '读取项目运行态（撤销、分数日志、倒计时）',
    handler: (ctx) => {
      const projectId = ctx.params.projectId;
      requireProject(projectId);
      const snapshot = runtime.getRuntimeSnapshot();
      return {
        data: {
          serverNow: snapshot.serverNow,
          undoCount: (snapshot.undoCounts && snapshot.undoCounts[projectId]) || 0,
          undoLabels: (snapshot.undoLabels && snapshot.undoLabels[projectId]) || [],
          scoreLogs: (snapshot.scoreLogs && snapshot.scoreLogs[projectId]) || [],
          countdown: (snapshot.countdowns && snapshot.countdowns[projectId]) || null,
        },
      };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/undo', mcp: 'undo_score', summary: '撤销最近一步记分', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.undoScore, { projectId: ctx.params.projectId }) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/undo-to', mcp: 'undo_to', summary: '连续撤销直到只剩 keep 条', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.undoTo, { projectId: ctx.params.projectId, keep: ctx.body.keep }) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/countdown/start', mcp: 'start_countdown', summary: '启动倒计时', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.countdownStart, { projectId: ctx.params.projectId, durationSec: ctx.body.durationSec }) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/countdown/pause', mcp: 'pause_countdown', summary: '暂停倒计时', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.countdownPause, { projectId: ctx.params.projectId }) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/countdown/resume', mcp: 'resume_countdown', summary: '继续倒计时', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.countdownResume, { projectId: ctx.params.projectId }) };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/runtime/countdown/reset', mcp: 'reset_countdown', summary: '重置倒计时', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      return { data: commit(OPS.countdownReset, { projectId: ctx.params.projectId }) };
    },
  },
];

module.exports = { routes, personOf, teamOf, sorted, page };
