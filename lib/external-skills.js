// 本机外部技能来源（Claude / Codex 全局技能目录）的扫描与比对。
//
// 定位：技能面「发现」模式的**本机来源**——与 skillhub.cn（外部市场）并列。只做三件事：
//   1. 扫描：列出各来源下可作为技能导入的条目，解析 frontmatter，读不出就如实报原因；
//   2. 比对：与 DSH 已有技能名比对，标出「已存在」（导入会被 importSkill 的防重名校验拒绝）；
//   3. 预览：读外部 SKILL.md 原文（不经市场、不落盘）。
// 导入本身**不在这里**：走 skills-file-ops 的 importSkill（type: 'directory'），与
// skillhub 安装、本机文件导入共用同一条落盘路径（防重名、拒绝符号链接、原子提交）。
//
// 为什么只扫顶层：Claude / Codex 的全局技能目录约定是一条目一目录（或一条目一 .md），
// 不存在合法的嵌套包。深扫会把 references/ 里的样例当成技能报出来。

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { diagnoseSkill } from "./skills-frontmatter.js";

/** SKILL.md 文件名（与 skills-file-ops 的 BUNDLE_FILE 同一约定）。 */
const BUNDLE_FILE = "SKILL.md";

/**
 * 默认来源清单。id 进 wire、进 UI 徽章，是稳定契约（不要改名）。
 * 路径按本机习惯解析：相对 `os.homedir()`。
 */
export const EXTERNAL_SOURCES = Object.freeze([
	{ id: "claude", label: "Claude", rel: join(".claude", "skills") },
	{ id: "codex", label: "Codex", rel: join(".codex", "skills") },
])

/** 目录不存在 / 不可读时的哨兵：来源整体不返回（面板不显示空来源）。 */
async function directoryExists(path) {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

/**
 * 解析一个外部条目（目录捆绑或扁平 .md）的技能身份。
 *
 * 读不出合法 frontmatter 不是错误：返回 `invalid: true` 与原因，让面板如实展示
 * 「这条导不进来、为什么」——猜一个名字等于把导入失败留到点击那一刻。
 *
 * @param {{ kind: 'bundle'|'flat', path: string, entry: string }} item
 * @returns {Promise<{ name: string|null, description: string, invalid?: string }>}
 */
async function readExternalSkillMeta(item) {
	try {
		const text = await readFile(item.kind === "flat" ? item.path : join(item.path, BUNDLE_FILE), "utf8")
		const diagnosed = diagnoseSkill(text)
		if (!diagnosed.ok) {
			const first = diagnosed.issues.find((issue) => issue.level === "error") ?? diagnosed.issues[0]
			return { name: null, description: "", invalid: first?.message ?? "frontmatter 不合格" }
		}
		// name 缺失回退目录/文件名（宿主按 frontmatter 定身份；这里只用于展示与比对）。
		const name = typeof diagnosed.name === "string" && diagnosed.name !== ""
			? diagnosed.name
			: item.entry.replace(/\.md$/i, "")
		return { name, description: typeof diagnosed.description === "string" ? diagnosed.description : "" }
	} catch (error) {
		return { name: null, description: "", invalid: `读取失败：${error?.message ?? error}` }
	}
}

/**
 * 扫描全部外部来源。
 *
 * @param {{ installedNames?: Iterable<string>, home?: string }} [input]
 *   installedNames —— DSH 侧已存在的技能名（全局+项目胜出视图），用于标 alreadyPresent。
 * @returns {Promise<{ sources: Array<{ id: string, label: string, path: string, skills: object[] }> }>}
 */
export async function scanExternalSkills(input = {}) {
	const home = typeof input.home === "string" && input.home !== "" ? input.home : homedir()
	const installed = new Set(input.installedNames ?? [])
	const sources = []
	for (const source of EXTERNAL_SOURCES) {
		const path = join(home, source.rel)
		if (!(await directoryExists(path))) continue
		let entries
		try {
			entries = await readdir(path, { withFileTypes: true })
		} catch {
			continue
		}
		const skills = []
		for (const entry of entries) {
			// 暂存/隐藏目录不是技能（与本插件自己的 `.dsh-import-*` 暂存约定一致）。
			if (entry.name.startsWith(".")) continue
			let item
			if (entry.isDirectory()) item = { kind: "bundle", path: join(path, entry.name), entry: entry.name }
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) item = { kind: "flat", path: join(path, entry.name), entry: entry.name }
			else continue
			const meta = await readExternalSkillMeta(item)
			skills.push({
				id: `${source.id}:${entry.name}`,
				sourceId: source.id,
				sourceLabel: source.label,
				entry: entry.name,
				kind: item.kind,
				path: item.path,
				...meta,
				alreadyPresent: meta.name !== null && installed.has(meta.name),
			})
		}
		if (skills.length > 0) sources.push({ id: source.id, label: source.label, path, skills })
	}
	return { sources }
}

/**
 * 读外部技能的 SKILL.md 原文（预览）。
 *
 * 定位只用 `sourceId + entry`（扫描结果里的稳定坐标），**不接受裸路径**：wire 上留一个
 * "任意路径读文件"的口子，任何调用方都能拿它读用户主目录——预览功能不需要这种能力。
 *
 * @param {{ sourceId: string, entry: string, kind?: 'bundle'|'flat' }} item
 * @returns {Promise<string>}
 */
export async function readExternalSkillDocument(item, home = homedir()) {
	const sourceId = String(item?.sourceId ?? "")
	const source = EXTERNAL_SOURCES.find((candidate) => candidate.id === sourceId)
	if (source === undefined) throw new Error(`未知的外部技能来源：${sourceId || "(空)"}`)
	const entry = String(item?.entry ?? "")
	// entry 拒绝路径分隔符与 `..`：坐标不是路径，接受子路径等于重新打开任意读。
	if (entry === "" || entry.includes("/") || entry.includes("\\") || entry === "." || entry === "..") {
		throw new Error("非法的外部技能条目名")
	}
	const base = join(home, source.rel)
	const kind = item?.kind === "flat" ? "flat" : "bundle"
	const path = kind === "flat" ? join(base, entry) : join(base, entry, BUNDLE_FILE)
	return await readFile(path, "utf8")
}
