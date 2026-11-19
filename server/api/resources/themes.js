'use strict';
const { state, getTheme, getThemeDraft } = require('../../state');
const { THEME_SETTING_KEYS } = require('../../settings');
const { themeSummary } = require('../../theme/schema');
const { OPS } = require('../../ops');
const {
  commit, requireProject, parseRevision,
} = require('./common');
const {
  ApiConflictError, ApiPreconditionError, ApiUnprocessableError, ApiNotFoundError,
} = require('../errors');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireRevision(theme, ctx) {
  const revision = parseRevision(ctx);
  if (revision == null) {
    throw new ApiPreconditionError('写主题必须提供 revision（If-Match 或 ?revision=）', {
      currentRevision: theme.meta.revision,
    });
  }
  if (revision !== '*' && revision !== theme.meta.revision) {
    throw new ApiConflictError('主题已被其他客户端修改', {
      expected: revision,
      currentRevision: theme.meta.revision,
    });
  }
}

function updateTheme(ctx, updater) {
  const theme = getTheme(ctx.params.themeId);
  requireRevision(theme, ctx);
  const next = updater(clone(theme));
  const result = commit(OPS.themeUpdate, { themeId: theme.meta.id, theme: next });
  return { data: getTheme(theme.meta.id), meta: { revision: result.theme.revision } };
}

function findLayer(theme, layerId) {
  const layer = theme.layers.find((item) => item.id === layerId);
  if (!layer) throw new ApiNotFoundError('图层不存在');
  return layer;
}

const routes = [
  {
    method: 'GET', path: '/themes', mcp: 'list_themes', summary: '列出主题库摘要',
    handler: () => ({
      data: Object.values(state.themes)
        .map(themeSummary)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    }),
  },
  {
    method: 'POST', path: '/themes', mcp: 'create_theme', summary: '新建空主题', mutates: true,
    handler: (ctx) => {
      const result = commit(OPS.themeCreate, { name: ctx.body.name });
      return { data: getTheme(result.themeId), status: 201 };
    },
  },
  {
    method: 'GET', path: '/themes/:themeId', mcp: 'get_theme', summary: '读取完整主题',
    handler: (ctx) => {
      const theme = getTheme(ctx.params.themeId);
      return { data: theme, meta: { revision: theme.meta.revision } };
    },
  },
  {
    method: 'PATCH', path: '/themes/:themeId', mcp: 'update_theme', summary: '整体替换主题（需 revision）', mutates: true,
    handler: (ctx) => {
      const body = ctx.body.theme !== undefined ? ctx.body.theme : ctx.body;
      return updateTheme(ctx, () => body);
    },
  },
  {
    method: 'DELETE', path: '/themes/:themeId', mcp: 'delete_theme', summary: '删除主题并解绑项目（需 revision）', mutates: true, destructive: true,
    handler: (ctx) => {
      const theme = getTheme(ctx.params.themeId);
      requireRevision(theme, ctx);
      const result = commit(OPS.themeDelete, { themeId: theme.meta.id });
      return { data: result };
    },
  },
  {
    method: 'POST', path: '/themes/:themeId/duplicate', mcp: 'duplicate_theme', summary: '复制主题', mutates: true,
    handler: (ctx) => {
      const theme = getTheme(ctx.params.themeId);
      requireRevision(theme, ctx);
      return { data: commit(OPS.themeDuplicate, { themeId: theme.meta.id }) };
    },
  },
  {
    method: 'POST', path: '/themes/:themeId/rename', mcp: 'rename_theme', summary: '重命名主题（需 revision）', mutates: true,
    handler: (ctx) => {
      const theme = getTheme(ctx.params.themeId);
      requireRevision(theme, ctx);
      return { data: commit(OPS.themeRename, { themeId: theme.meta.id, name: ctx.body.name }) };
    },
  },
  {
    method: 'POST', path: '/themes/import', mcp: 'import_theme', summary: '导入主题（新 ID）', mutates: true,
    handler: (ctx) => {
      const theme = ctx.body.theme !== undefined ? ctx.body.theme : ctx.body;
      const result = commit(OPS.themeImport, { theme });
      return { data: getTheme(result.themeId), status: 201 };
    },
  },
  {
    method: 'POST', path: '/themes/:themeId/apply', mcp: 'apply_theme', summary: '把主题应用到项目', mutates: true,
    handler: (ctx) => {
      const theme = getTheme(ctx.params.themeId);
      requireRevision(theme, ctx);
      const project = requireProject(ctx.body.projectId || ctx.query.projectId);
      return { data: commit(OPS.themeApply, { projectId: project.id, themeId: theme.meta.id }) };
    },
  },

  // ---------- 子资源 ----------
  {
    method: 'GET', path: '/themes/:themeId/meta', mcp: 'get_theme_meta', summary: '读取主题元数据',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).meta }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/meta', mcp: 'update_theme_meta', summary: '修改主题名称/作者/说明/基础风格（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const allowed = ['name', 'author', 'description', 'baseStyle'];
      for (const key of allowed) {
        if (ctx.body[key] !== undefined) theme.meta[key] = ctx.body[key];
      }
      return theme;
    }),
  },
  {
    method: 'GET', path: '/themes/:themeId/canvas', mcp: 'get_theme_canvas', summary: '读取主题画布',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).canvas }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/canvas', mcp: 'update_theme_canvas', summary: '替换主题画布（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      theme.canvas = ctx.body.canvas !== undefined ? ctx.body.canvas : ctx.body;
      return theme;
    }),
  },
  {
    method: 'GET', path: '/themes/:themeId/layers', mcp: 'get_theme_layers', summary: '读取主题图层与节点',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).layers }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/layers', mcp: 'update_theme_layers', summary: '整段替换主题图层（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      theme.layers = ctx.body.layers !== undefined ? ctx.body.layers : ctx.body;
      return theme;
    }),
  },
  {
    method: 'GET', path: '/themes/:themeId/layers/:layerId', mcp: 'get_theme_layer', summary: '读取单个图层',
    handler: (ctx) => ({ data: findLayer(getTheme(ctx.params.themeId), ctx.params.layerId) }),
  },
  {
    method: 'PUT', path: '/themes/:themeId/layers/:layerId', mcp: 'put_theme_layer', summary: '新增或替换单个图层（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const layer = ctx.body.layer !== undefined ? ctx.body.layer : ctx.body;
      if (!layer || typeof layer !== 'object') throw new ApiUnprocessableError('图层内容非法');
      const value = { ...layer, id: layer.id || ctx.params.layerId };
      const index = theme.layers.findIndex((item) => item.id === ctx.params.layerId);
      if (index >= 0) theme.layers[index] = value;
      else theme.layers.push(value);
      return theme;
    }),
  },
  {
    method: 'DELETE', path: '/themes/:themeId/layers/:layerId', mcp: 'delete_theme_layer', summary: '删除图层（需 revision）', mutates: true, destructive: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      if (theme.layers.length <= 1) throw new ApiUnprocessableError('至少保留一个图层');
      const exists = theme.layers.some((item) => item.id === ctx.params.layerId);
      if (!exists) throw new ApiNotFoundError('图层不存在');
      theme.layers = theme.layers.filter((item) => item.id !== ctx.params.layerId);
      return theme;
    }),
  },
  {
    method: 'PUT', path: '/themes/:themeId/layers/:layerId/nodes/:nodeId', mcp: 'put_theme_node', summary: '新增或替换图层中的节点（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const layer = findLayer(theme, ctx.params.layerId);
      const node = ctx.body.node !== undefined ? ctx.body.node : ctx.body;
      if (!node || typeof node !== 'object') throw new ApiUnprocessableError('节点内容非法');
      const value = { ...node, id: node.id || ctx.params.nodeId };
      const index = layer.nodes.findIndex((item) => item.id === ctx.params.nodeId);
      if (index >= 0) layer.nodes[index] = value;
      else layer.nodes.push(value);
      return theme;
    }),
  },
  {
    method: 'DELETE', path: '/themes/:themeId/layers/:layerId/nodes/:nodeId', mcp: 'delete_theme_node', summary: '删除图层中的节点（需 revision）', mutates: true, destructive: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const layer = findLayer(theme, ctx.params.layerId);
      const exists = layer.nodes.some((item) => item.id === ctx.params.nodeId);
      if (!exists) throw new ApiNotFoundError('节点不存在');
      layer.nodes = layer.nodes.filter((item) => item.id !== ctx.params.nodeId);
      return theme;
    }),
  },
  {
    method: 'GET', path: '/themes/:themeId/widgets', mcp: 'get_theme_widgets', summary: '读取主题控件',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).widgets }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/widgets', mcp: 'update_theme_widgets', summary: '整段替换主题控件（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      theme.widgets = ctx.body.widgets !== undefined ? ctx.body.widgets : ctx.body;
      return theme;
    }),
  },
  {
    method: 'PUT', path: '/themes/:themeId/widgets/:widgetId', mcp: 'put_theme_widget', summary: '新增或替换单个控件（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const widget = ctx.body.widget !== undefined ? ctx.body.widget : ctx.body;
      if (!widget || typeof widget !== 'object') throw new ApiUnprocessableError('控件内容非法');
      const value = { ...widget, id: widget.id || ctx.params.widgetId };
      const index = theme.widgets.findIndex((item) => item.id === ctx.params.widgetId);
      if (index >= 0) theme.widgets[index] = value;
      else theme.widgets.push(value);
      return theme;
    }),
  },
  {
    method: 'DELETE', path: '/themes/:themeId/widgets/:widgetId', mcp: 'delete_theme_widget', summary: '删除控件（需 revision）', mutates: true, destructive: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      const exists = theme.widgets.some((item) => item.id === ctx.params.widgetId);
      if (!exists) throw new ApiNotFoundError('控件不存在');
      theme.widgets = theme.widgets.filter((item) => item.id !== ctx.params.widgetId);
      return theme;
    }),
  },
  {
    method: 'GET', path: '/themes/:themeId/settings', mcp: 'get_theme_settings', summary: '读取主题视觉设置',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).settings }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/settings', mcp: 'update_theme_settings', summary: '修改主题视觉设置（未知键 422，需 revision）', mutates: true,
    handler: (ctx) => {
      const patch = ctx.body.settings !== undefined ? ctx.body.settings : ctx.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ApiUnprocessableError('主题设置必须是对象');
      }
      const unknownKeys = Object.keys(patch).filter((key) => !THEME_SETTING_KEYS.has(key));
      if (unknownKeys.length) throw new ApiUnprocessableError('主题包含不支持的设置项', { unknownKeys });
      return updateTheme(ctx, (theme) => {
        theme.settings = { ...theme.settings, ...patch };
        return theme;
      });
    },
  },
  {
    method: 'GET', path: '/themes/:themeId/script', mcp: 'get_theme_script', summary: '读取主题沙箱脚本',
    handler: (ctx) => ({ data: getTheme(ctx.params.themeId).script }),
  },
  {
    method: 'PATCH', path: '/themes/:themeId/script', mcp: 'update_theme_script', summary: '修改主题沙箱脚本（需 revision）', mutates: true,
    handler: (ctx) => updateTheme(ctx, (theme) => {
      theme.script = ctx.body.script !== undefined ? ctx.body.script : ctx.body;
      return theme;
    }),
  },

  // ---------- 项目草稿 ----------
  {
    method: 'GET', path: '/projects/:projectId/theme-draft', mcp: 'get_theme_draft', summary: '读取项目主题草稿',
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const draft = getThemeDraft(ctx.params.projectId);
      return { data: draft, meta: { revision: draft && draft.meta ? draft.meta.revision : 0 } };
    },
  },
  {
    method: 'PATCH', path: '/projects/:projectId/theme-draft', mcp: 'save_theme_draft', summary: '保存项目主题草稿（已有草稿需 revision）', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const existing = getThemeDraft(ctx.params.projectId);
      if (existing) {
        const revision = parseRevision(ctx);
        if (revision == null) {
          throw new ApiPreconditionError('覆盖草稿必须提供 revision', { currentRevision: existing.meta.revision });
        }
        if (revision !== '*' && revision !== existing.meta.revision) {
          throw new ApiConflictError('草稿已被其他客户端修改', {
            expected: revision, currentRevision: existing.meta.revision,
          });
        }
      }
      const theme = ctx.body.theme !== undefined ? ctx.body.theme : ctx.body;
      const result = commit(OPS.draftSave, { projectId: ctx.params.projectId, theme });
      const saved = getThemeDraft(ctx.params.projectId);
      return { data: saved, meta: { revision: saved.meta.revision, summary: result.theme } };
    },
  },
  {
    method: 'DELETE', path: '/projects/:projectId/theme-draft', mcp: 'delete_theme_draft', summary: '删除项目主题草稿', mutates: true, destructive: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      commit(OPS.draftDelete, { projectId: ctx.params.projectId });
      return { data: { deleted: true } };
    },
  },
  {
    method: 'POST', path: '/projects/:projectId/theme-draft/apply', mcp: 'apply_theme_draft', summary: '把草稿发布到主题库并应用', mutates: true,
    handler: (ctx) => {
      requireProject(ctx.params.projectId);
      const draft = getThemeDraft(ctx.params.projectId);
      if (!draft) throw new ApiNotFoundError('项目还没有主题草稿');
      const imported = commit(OPS.themeImport, { theme: draft });
      const applied = commit(OPS.themeApply, { projectId: ctx.params.projectId, themeId: imported.themeId });
      return {
        data: applied,
        meta: { themeId: imported.themeId, revision: applied.revision },
      };
    },
  },
];

module.exports = { routes };
