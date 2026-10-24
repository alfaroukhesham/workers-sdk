import * as fs from "node:fs";
import path from "node:path";
import { watch } from "chokidar";
import type { EventName } from "chokidar/handler.js";

/**
 * A minimal watcher surface shared by the chokidar and recursive `fs.watch`
 * backends so `#ensureWatchingAssets` can treat them the same.
 */
export type AssetsWatcher = {
	close(): void | Promise<void>;
	on(
		event: "all",
		listener: (eventName: EventName, filePath: string) => void | Promise<void>
	): AssetsWatcher;
	on(event: "error", listener: (error: Error) => void): AssetsWatcher;
};

/**
 * Watch an assets directory for changes that should trigger a local-dev reload.
 *
 * On macOS and Windows this uses a single recursive `fs.watch`, which is one
 * FSEvents / ReadDirectoryChangesW handle for the whole tree. Chokidar 4
 * otherwise opens one `fs.watch` (kqueue) per file on those platforms, and
 * past macOS `OPEN_MAX` (10240) child-process spawns fail with `EBADF`
 * without ever raising `EMFILE`.
 *
 * Linux keeps chokidar: its inotify backend watches directories rather than
 * each file, so a large assets tree does not exhaust descriptors the same way.
 *
 * @param assetsDir Absolute path of the assets directory to watch.
 * @param ignoredDirs Directories whose writes must not reload (for example
 * `.wrangler` and the persist directory). Callers must already omit the
 * assets directory itself when it would otherwise appear in this list.
 * @returns A watcher with chokidar-like `on("all" | "error")` and `close()`.
 */
export function watchAssetsDirectory(
	assetsDir: string,
	ignoredDirs: string[]
): AssetsWatcher {
	if (process.platform === "darwin" || process.platform === "win32") {
		return watchAssetsDirectoryRecursive(assetsDir, ignoredDirs);
	}
	return watchAssetsDirectoryChokidar(assetsDir, ignoredDirs);
}

function watchAssetsDirectoryChokidar(
	assetsDir: string,
	ignoredDirs: string[]
): AssetsWatcher {
	return watch(assetsDir, {
		persistent: true,
		ignoreInitial: true,
		// Chokidar does not walk an ignored directory, so writes under
		// `.wrangler` and `dev.persist` do not reload.
		ignored: ignoredDirs,
	});
}

function watchAssetsDirectoryRecursive(
	assetsDir: string,
	ignoredDirs: string[]
): AssetsWatcher {
	const nativeWatcher = fs.watch(assetsDir, {
		persistent: true,
		recursive: true,
		encoding: "utf8",
	});

	const allListeners: Array<
		(eventName: EventName, filePath: string) => void | Promise<void>
	> = [];
	const errorListeners: Array<(error: Error) => void> = [];

	nativeWatcher.on("change", (_eventType, filename) => {
		// Native backends can omit the filename. Falling back to `assetsDir`
		// would make the ignore check always miss: `.wrangler` and persist
		// live *inside* the assets tree when assets is the project root, so
		// a write there would look like a change to the root and reload.
		// Dropping the event is safer than a spurious refresh. Named events
		// still hot-reload real asset edits.
		if (filename == null || filename === "") {
			return;
		}
		const filePath = path.resolve(assetsDir, filename.toString());
		if (ignoredDirs.some((dir) => isPathInsideDir(filePath, dir))) {
			return;
		}
		for (const listener of allListeners) {
			void listener("change", filePath);
		}
	});

	nativeWatcher.on("error", (error: Error) => {
		for (const listener of errorListeners) {
			listener(error);
		}
	});

	const watcher: AssetsWatcher = {
		close() {
			// Real `fs.watch` closes synchronously (`void`). Tests delay close
			// with a Promise, which `#ensureWatchingAssets` / `teardown` await.
			return nativeWatcher.close() as unknown as void | Promise<void>;
		},
		on(event, listener) {
			if (event === "all") {
				allListeners.push(
					listener as (
						eventName: EventName,
						filePath: string
					) => void | Promise<void>
				);
			} else {
				errorListeners.push(listener as (error: Error) => void);
			}
			return watcher;
		},
	};
	return watcher;
}

/**
 * Resolve a path for watcher ignore checks. Windows paths that differ
 * only by case name the same directory, so fold case on `win32`.
 */
function comparablePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Whether two paths name the same directory after platform normalization.
 */
export function isSameWatchPath(left: string, right: string): boolean {
	return comparablePath(left) === comparablePath(right);
}

/**
 * Whether `target` is `dir` or a path inside it.
 *
 * A prefix check that requires a path separator after `dir` so that
 * `.wrangler-backup` is not treated as inside `.wrangler`. On Windows
 * the comparison is case-insensitive so persist directories reported
 * with different capitalization are still ignored.
 */
function isPathInsideDir(target: string, dir: string): boolean {
	const resolvedDir = comparablePath(dir);
	const resolvedTarget = comparablePath(target);
	const prefix = resolvedDir.endsWith(path.sep)
		? resolvedDir
		: resolvedDir + path.sep;
	return resolvedTarget === resolvedDir || resolvedTarget.startsWith(prefix);
}
