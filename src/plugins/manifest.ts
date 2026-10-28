import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  PLUGIN_SCHEMA_VERSION,
  RESERVED_PLUGIN_IDS,
  type PluginManifest,
  type PluginPanelDescriptor,
  type PluginPermission,
} from "./types.js";

const ID_PATTERN = "^[a-z][a-z0-9-]*$";

const ManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(PLUGIN_SCHEMA_VERSION),
    id: Type.String({ pattern: ID_PATTERN, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    version: Type.String({ minLength: 1, maxLength: 40 }),
    description: Type.String({ minLength: 1, maxLength: 400 }),
    entry: Type.String({ minLength: 1 }),
    configSchema: Type.Optional(Type.String({ minLength: 1 })),
    panel: Type.Optional(
      Type.Object({
        entry: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1, maxLength: 80 }),
        icon: Type.Optional(Type.String({ maxLength: 40 })),
        route: Type.String({ pattern: ID_PATTERN, maxLength: 64 }),
        order: Type.Optional(Type.Number()),
      }),
    ),
    permissions: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("tools"),
          Type.Literal("perception"),
          Type.Literal("storage"),
          Type.Literal("realtime"),
          Type.Literal("config"),
          Type.Literal("llm-routing"),
        ]),
      ),
    ),
  },
  { additionalProperties: true },
);

export class PluginManifestError extends Error {
  constructor(
    readonly pluginDir: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginManifestError";
  }
}

export interface DiscoveredPlugin {
  dir: string;
  manifestPath: string;
  manifest: PluginManifest;
  entryPath: string;
  configSchemaPath?: string;
  panelEntryPath?: string;
}

/** 扫描 pluginsRoot 下所有含 module.json 的目录;坏插件只报错,不影响其他插件 */
export function discoverPlugins(pluginsRoot: string): {
  plugins: DiscoveredPlugin[];
  errors: { dir: string; message: string }[];
} {
  const plugins: DiscoveredPlugin[] = [];
  const errors: { dir: string; message: string }[] = [];
  const root = resolve(pluginsRoot);
  if (!existsSync(root)) return { plugins, errors };

  const seen = new Map<string, string>();
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "module.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = readManifest(manifestPath);
      const previous = seen.get(manifest.id);
      if (previous) {
        throw new PluginManifestError(dir, `插件 id 冲突: "${manifest.id}" 已被 ${previous} 使用`);
      }
      seen.set(manifest.id, dir);
      plugins.push(resolveEntryPaths(dir, manifest, manifestPath));
    } catch (err) {
      errors.push({ dir, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plugins, errors };
}

function readManifest(manifestPath: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new PluginManifestError(manifestPath, `module.json 解析失败: ${String(err)}`);
  }
  if (!Value.Check(ManifestSchema, raw)) {
    const issues = [...Value.Errors(ManifestSchema, raw)].slice(0, 8).map((e) => `${e.instancePath || "$"}: ${e.message}`);
    throw new PluginManifestError(manifestPath, `module.json 校验失败: ${issues.join("; ")}`);
  }
  const manifest = raw as PluginManifest;
  if (RESERVED_PLUGIN_IDS.has(manifest.id)) {
    throw new PluginManifestError(manifestPath, `插件 id "${manifest.id}" 是保留名`);
  }
  return manifest;
}

function resolveEntryPaths(dir: string, manifest: PluginManifest, manifestPath: string): DiscoveredPlugin {
  const resolveInside = (rel: string, field: string): string => {
    const target = resolve(dir, rel);
    if (!isInside(dir, target)) {
      throw new PluginManifestError(manifestPath, `${field} 必须位于插件目录内: ${rel}`);
    }
    if (!existsSync(target)) {
      throw new PluginManifestError(manifestPath, `${field} 指向的文件不存在: ${rel}`);
    }
    return target;
  };
  const entryPath = resolveInside(manifest.entry, "entry");
  const panelEntryPath = manifest.panel ? resolveInside(manifest.panel.entry, "panel.entry") : undefined;
  const configSchemaPath = manifest.configSchema
    ? resolveInside(manifest.configSchema, "configSchema")
    : undefined;
  return { dir, manifestPath, manifest, entryPath, configSchemaPath, panelEntryPath };
}

/** 严格包含判断(防止 ../ 与符号链接式越权) */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(`..${sep}`);
}

export function panelOf(manifest: PluginManifest): PluginPanelDescriptor | undefined {
  return manifest.panel;
}

export function permissionsOf(manifest: PluginManifest): PluginPermission[] {
  return manifest.permissions ?? [];
}
