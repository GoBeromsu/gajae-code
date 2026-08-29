import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getTelemetryInstallId, serializeTelemetryEvent } from "../src/telemetry/events";

const tempDirs: string[] = [];
const realOpen = fs.open;
const realLstat = fs.lstat;
const realStat = fs.stat.bind(fs);
const realBunFile = Bun.file;
const realBunSleep = Bun.sleep;

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("telemetry event serializer", () => {
	it("emits only the versioned allowlist", () => {
		const serialized = serializeTelemetryEvent({
			event: "update_check_completed",
			installId: "123e4567-e89b-42d3-a456-426614174000",
			occurredAt: "2026-08-28T17:00:00.000Z",
			channel: "stable",
			result: "up_to_date",
			unknown: "must not be emitted",
		});

		expect(JSON.parse(serialized)).toEqual({
			schemaVersion: 1,
			event: "update_check_completed",
			installId: "123e4567-e89b-42d3-a456-426614174000",
			occurredAt: "2026-08-28T17:00:00.000Z",
			channel: "stable",
			result: "up_to_date",
		});
	});

	it.each([
		{ prompt: "secret prompt", event: "update_check_completed" },
		{ argv: ["gjc", "update"], event: "update_check_completed" },
		{ path: "/home/alice/project", event: "update_check_completed" },
		{ env: { TOKEN: "secret" }, event: "update_check_completed" },
		{ nested: { provider: "secret-provider" }, event: "update_check_completed" },
		{ nested: { arbitraryError: "private failure" }, event: "update_check_completed" },
	])("rejects forbidden data: $", value => {
		expect(() =>
			serializeTelemetryEvent({
				...value,
				installId: "123e4567-e89b-42d3-a456-426614174000",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("forbidden data");
	});

	it("rejects unsupported event and identity values", () => {
		expect(() =>
			serializeTelemetryEvent({
				event: "arbitrary_event",
				installId: "123e4567-e89b-42d3-a456-426614174000",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("invalid telemetry event");
		expect(() =>
			serializeTelemetryEvent({
				event: "update_check_completed",
				installId: "not-a-uuid",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("invalid telemetry installId");
	});
});

describe("telemetry install ID", () => {
	it("creates a random UUIDv4 and reuses it without machine-derived input", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");

		const first = await getTelemetryInstallId(filePath);
		const second = await getTelemetryInstallId(filePath);

		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(second).toBe(first);
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("fails closed on a malformed persisted ID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "derived-from-hostname\n", { mode: 0o600 });

		await expect(getTelemetryInstallId(filePath)).rejects.toThrow("malformed");
	});

	it("publishes only complete payloads despite a delayed competing publisher", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const originalLink = fs.link.bind(fs);
		let linkCalls = 0;
		const linkSpy = spyOn(fs, "link").mockImplementation(async (temporaryPath, destinationPath) => {
			if (linkCalls++ === 0) await Bun.sleep(150);
			return originalLink(temporaryPath, destinationPath);
		});

		try {
			const ids = await Promise.all([getTelemetryInstallId(filePath), getTelemetryInstallId(filePath)]);
			expect(ids[0]).toBe(ids[1]);
			expect((await fs.readFile(filePath, "utf8")).endsWith("\n")).toBe(true);
			expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
		} finally {
			linkSpy.mockRestore();
		}
	});

	it("tightens permissions when reusing an existing valid ID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o644 });

		expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("tightens permissions after concurrent creation races", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");

		const ids = await Promise.all([getTelemetryInstallId(filePath), getTelemetryInstallId(filePath)]);

		expect(ids[0]).toBe(ids[1]);
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("converges three concurrent callers on one published winner", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");

		const ids = await Promise.all([
			getTelemetryInstallId(filePath),
			getTelemetryInstallId(filePath),
			getTelemetryInstallId(filePath),
		]);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[1]).toBe(ids[2]);
	});

	it("syncs the containing directory after publishing", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const originalOpen = realOpen;
		const openedPaths: string[] = [];
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			openedPaths.push(String(args[0]));
			return originalOpen(...args);
		});

		try {
			await getTelemetryInstallId(filePath);
			expect(openedPaths).toContain(directory);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("does not adopt stale temporary payloads and cleans its own temporary file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const staleTempPath = `${filePath}.stale.tmp`;
		await fs.writeFile(staleTempPath, "not-a-published-id\n", { mode: 0o600 });

		const id = await getTelemetryInstallId(filePath);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(await fs.readFile(staleTempPath, "utf8")).toBe("not-a-published-id\n");
		expect((await fs.readdir(directory)).sort()).toEqual(["telemetry-install-id", "telemetry-install-id.stale.tmp"]);
	});

	it("converges through a claim when the profile filesystem rejects hard links", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		try {
			const ids = await Promise.all([getTelemetryInstallId(filePath), getTelemetryInstallId(filePath)]);
			expect(ids[0]).toBe(ids[1]);
			expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
			expect(await fs.readdir(directory)).toEqual(["telemetry-install-id"]);
		} finally {
			linkSpy.mockRestore();
		}
	});

	it("fails closed on a stale claim without removing the hostile claim", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(claimPath, "hostile-claim", { mode: 0o600 });
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("claim did not clear");
			expect(await fs.readFile(claimPath, "utf8")).toBe("hostile-claim");
		} finally {
			linkSpy.mockRestore();
		}
	});

	it("fails closed when a raced winner never publishes a valid UUID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "", { mode: 0o600 });
		await expect(getTelemetryInstallId(filePath)).rejects.toThrow("malformed");
	});

	it("recovers an expired claim without adopting a partial payload", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(`${filePath}.lock`, `crashed-publisher\npublishing\n${Date.now() - 1}`, { mode: 0o600 });
		await fs.writeFile(`${filePath}.crashed.tmp`, "", { mode: 0o600 });

		const id = await getTelemetryInstallId(filePath);
		expect(id).toMatch(UUID_PATTERN);
		expect(await fs.readFile(`${filePath}.crashed.tmp`, "utf8")).toBe("");
		expect((await fs.readdir(directory)).sort()).toEqual([
			"telemetry-install-id",
			"telemetry-install-id.crashed.tmp",
		]);
	});

	it("does not delete a replacement claim during stale recovery", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(claimPath, `expired\npublishing\n${Date.now() - 1}`, { mode: 0o600 });
		const originalReadFile = fs.readFile.bind(fs);
		let replaced = false;
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (file, options) => {
			const result = await originalReadFile(file, options as never);
			if (!replaced && String(file) === claimPath) {
				replaced = true;
				await fs.rm(claimPath);
				await fs.writeFile(claimPath, "replacement-claim", { mode: 0o600 });
			}
			return result as never;
		});

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("claim did not clear");
			expect(await fs.readFile(claimPath, "utf8")).toBe("replacement-claim");
		} finally {
			readSpy.mockRestore();
		}
	});

	it.each([
		"EPERM",
		"EACCES",
	] as const)("treats a Windows %s directory sync as a supported durability limitation", async code => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const originalOpen = realOpen;
		const originalPlatform = process.platform;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]) === directory) {
				const error = new Error("directory handles are unsupported") as NodeJS.ErrnoException;
				error.code = code;
				throw error;
			}
			return originalOpen(...args);
		});

		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			expect(await getTelemetryInstallId(filePath)).toMatch(UUID_PATTERN);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
			openSpy.mockRestore();
		}
	});

	it("keeps readers behind the claim until the publisher sync completes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		const originalOpen = realOpen;
		let releaseSync!: () => void;
		const syncPaused = new Promise<void>(resolve => {
			releaseSync = resolve;
		});
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await originalOpen(...args);
			if (String(args[0]) === directory) {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					await syncPaused;
					await originalSync();
				};
			}
			return handle;
		});

		try {
			const publisher = getTelemetryInstallId(filePath);
			while (!(await fs.stat(`${filePath}.lock`).catch(() => undefined))) await Bun.sleep(1);
			let readerFinished = false;
			const reader = getTelemetryInstallId(filePath).then(() => {
				readerFinished = true;
			});
			await Bun.sleep(10);
			expect(readerFinished).toBe(false);
			await Bun.sleep(1_200);
			expect(readerFinished).toBe(false);
			releaseSync();
			await Promise.all([publisher, reader]);
			expect(await fs.readFile(filePath, "utf8")).toMatch(/\n$/);
		} finally {
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("recovers a crash after rename only after establishing directory durability", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, `crashed\npublishing\n${Date.now() - 1}`, { mode: 0o600 });

		expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect(await fs.stat(claimPath).catch(() => undefined)).toBeUndefined();
	});

	it("fails closed when ownership is replaced before commit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		const replacement = (async () => {
			while (!(await fs.stat(filePath).catch(() => undefined))) await Bun.sleep(1);
			await fs.rm(claimPath);
			await fs.writeFile(claimPath, "replacement-claim", { mode: 0o600 });
		})();

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow(/claim changed|ownership was lost|ENOENT/);
			await replacement;
			expect(await fs.readFile(claimPath, "utf8")).toStartWith("replacement-claim");
		} finally {
			linkSpy.mockRestore();
		}
	});

	it("cleans a stale committed claim without re-publishing the UUID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, "committed\ncommitted\n", { mode: 0o600 });
		await fs.utimes(claimPath, new Date(Date.now() - 3_000), new Date(Date.now() - 3_000));

		expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect(await fs.stat(claimPath).catch(() => undefined)).toBeUndefined();
	});

	it("retries when a claim disappears between read and identity lstat", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, "committed\ncommitted\n", { mode: 0o600 });
		let claimLstatCalls = 0;
		const lstatSpy = spyOn(fs, "lstat").mockImplementation(async (file, options) => {
			if (String(file) === claimPath && ++claimLstatCalls === 2) {
				await fs.rm(claimPath);
				const error = new Error("claim disappeared") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return (await realLstat(file, options as never)) as never;
		});

		try {
			expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it("fails closed when a claim is replaced between identity lstat and read", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, "committed\ncommitted\n", { mode: 0o600 });
		const originalReadFile = fs.readFile.bind(fs);
		let replaced = false;
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (file, options) => {
			const result = await originalReadFile(file, options as never);
			if (!replaced && String(file) === claimPath) {
				replaced = true;
				await fs.rm(claimPath);
				await fs.writeFile(claimPath, "replacement-claim", { mode: 0o600 });
			}
			return result as never;
		});

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("claim did not clear");
			expect(await fs.readFile(claimPath, "utf8")).toBe("replacement-claim");
		} finally {
			readSpy.mockRestore();
		}
	});

	it("accepts a UUID only after a publisher releases its claim", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, "committed\ncommitted\n", { mode: 0o600 });
		let raceFired = false;
		const fileSpy = spyOn(Bun, "file").mockImplementation(file => {
			const target = realBunFile(file as string);
			if (String(file) !== filePath) return target;
			return new Proxy(target, {
				get(object, property, receiver) {
					if (property !== "text") return Reflect.get(object, property, receiver);
					return async () => {
						const result = await object.text();
						await fs.rm(claimPath, { force: true });
						raceFired = true;
						return result;
					};
				},
			});
		});

		try {
			expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		} finally {
			expect(raceFired).toBe(true);
			fileSpy.mockRestore();
		}
	});

	it("does not reclaim a claim renewed during stale recovery", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, `expired|publishing|${Date.now() - 1}\n`, { mode: 0o600 });
		const originalReadFile = fs.readFile.bind(fs);
		let claimReads = 0;
		const readSpy = spyOn(fs, "readFile").mockImplementation(async (file, options) => {
			const result = await originalReadFile(file, options as never);
			if (String(file) === claimPath && ++claimReads === 4)
				await fs.writeFile(claimPath, "expired|publishing\n", { flag: "a" });
			return result as never;
		});
		const renewalTimer = setInterval(() => {
			void fs.writeFile(claimPath, "expired|publishing\n", { flag: "a" });
		}, 500);

		try {
			const waiter = getTelemetryInstallId(filePath);
			await Bun.sleep(1_200);
			expect(await fs.stat(claimPath).catch(() => undefined)).toBeDefined();
			clearInterval(renewalTimer);
			await expect(waiter).rejects.toThrow("claim did not clear");
			expect(await fs.readFile(claimPath, "utf8")).toContain("publishing");
		} finally {
			clearInterval(renewalTimer);
			readSpy.mockRestore();
		}
	});

	it("recovers a stale claim after a completed no-expiry heartbeat", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, "stale|publishing\n", { mode: 0o600 });
		await fs.utimes(claimPath, new Date(Date.now() - 3_000), new Date(Date.now() - 3_000));

		expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect(await fs.stat(claimPath).catch(() => undefined)).toBeUndefined();
	});

	it("uses bounded claim polls and promptly observes release", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(claimPath, "waiter", { mode: 0o600 });
		let pollCount = 0;
		const sleepSpy = spyOn(Bun, "sleep").mockImplementation(async milliseconds => {
			pollCount++;
			return realBunSleep(milliseconds);
		});
		const started = performance.now();
		const release = setTimeout(() => {
			void fs.rm(claimPath);
		}, 60);
		release.unref();

		try {
			expect(await getTelemetryInstallId(filePath)).toMatch(UUID_PATTERN);
			expect(performance.now() - started).toBeLessThan(500);
			expect(pollCount).toBeLessThan(10);
		} finally {
			clearTimeout(release);
			sleepSpy.mockRestore();
		}
	});

	it("uses one directory barrier for first observation, not steady-state reads", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		let directoryOpens = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]) === directory) {
				directoryOpens++;
				if (directoryOpens === 1) return realOpen(...args);
				const error = new Error("steady-state directory sync must not run") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return realOpen(...args);
		});

		try {
			expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
			expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
			expect(directoryOpens).toBe(1);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("keeps slow claim refreshes single-flight and does not retain exit", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		let releaseSync!: () => void;
		let directorySyncStarted!: () => void;
		const syncGate = new Promise<void>(resolve => {
			releaseSync = resolve;
		});
		const syncStarted = new Promise<void>(resolve => {
			directorySyncStarted = resolve;
		});
		let activeRefreshes = 0;
		let maximumRefreshes = 0;
		let refreshes = 0;
		let claimOpens = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (String(args[0]) === directory) {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					directorySyncStarted();
					await syncGate;
					await originalSync();
				};
			}
			if (String(args[0]) === claimPath && args[1] === "r+" && ++claimOpens % 2 === 0) {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					refreshes++;
					activeRefreshes++;
					maximumRefreshes = Math.max(maximumRefreshes, activeRefreshes);
					await Bun.sleep(80);
					await originalSync();
					activeRefreshes--;
				};
			}
			return handle;
		});

		try {
			const publisher = getTelemetryInstallId(filePath);
			while (!(await fs.stat(claimPath).catch(() => undefined))) await Bun.sleep(1);
			await syncStarted;
			let readerFinished = false;
			const reader = getTelemetryInstallId(filePath).then(() => {
				readerFinished = true;
			});
			await Bun.sleep(1_200);
			expect(readerFinished).toBe(false);
			expect(maximumRefreshes).toBeLessThanOrEqual(1);
			expect(refreshes).toBeGreaterThan(0);
			releaseSync();
			await Promise.all([publisher, reader]);
		} finally {
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("drains an in-flight refresh before failed publication cleanup", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>(resolve => {
			releaseRefresh = resolve;
		});
		let temporaryOpens = 0;
		let refreshes = 0;
		let claimOpens = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (String(args[0]) === claimPath && args[1] === "r+" && ++claimOpens % 2 === 0) {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					refreshes++;
					await refreshGate;
					await originalSync();
				};
			}
			if (
				String(args[0]).startsWith(`${filePath}.`) &&
				String(args[0]).endsWith(".tmp") &&
				!String(args[0]).includes(".lock.") &&
				++temporaryOpens === 2
			) {
				await handle.close();
				await Bun.sleep(100);
				const error = new Error("staged write failed") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}
			return handle;
		});

		try {
			const publisher = getTelemetryInstallId(filePath).then(
				() => undefined,
				error => error,
			);
			await Bun.sleep(50);
			releaseRefresh();
			const failure = await publisher;
			expect(failure).toMatchObject({ code: "EIO" });
			expect(refreshes).toBeGreaterThan(0);
			expect(await fs.stat(claimPath).catch(() => undefined)).toBeUndefined();
		} finally {
			releaseRefresh();
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("completes partial lease and commit generation writes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		let claimOpens = 0;
		let partialWrites = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (String(args[0]) === claimPath && args[1] === "r+" && ++claimOpens % 2 === 0) {
				const originalWrite = handle.write.bind(handle);
				handle.write = (async (buffer, offset, length, position) => {
					partialWrites++;
					return originalWrite(buffer, offset, Math.min(1, length ?? 0), position);
				}) as typeof handle.write;
			}
			return handle;
		});

		try {
			expect(await getTelemetryInstallId(filePath)).toMatch(UUID_PATTERN);
			expect(partialWrites).toBeGreaterThan(1);
		} finally {
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("fails closed when a lease refresh sync fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		let claimOpens = 0;
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (String(args[0]) === claimPath && args[1] === "r+" && ++claimOpens % 2 === 0) {
				handle.sync = async () => {
					const error = new Error("claim sync failed") as NodeJS.ErrnoException;
					error.code = "EIO";
					throw error;
				};
			}
			return handle;
		});

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("claim sync failed");
		} finally {
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("keeps a committed transition leased during slow sync", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		const linkSpy = spyOn(fs, "link").mockImplementation(async () => {
			const error = new Error("hard links are unavailable") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		let releaseCommitSync!: () => void;
		let commitSyncStarted!: () => void;
		const commitGate = new Promise<void>(resolve => {
			releaseCommitSync = resolve;
		});
		const commitStarted = new Promise<void>(resolve => {
			commitSyncStarted = resolve;
		});
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			if (String(args[0]) === claimPath && args[1] === "r") {
				const originalSync = handle.sync.bind(handle);
				handle.sync = async () => {
					if (await fs.stat(filePath).catch(() => undefined)) {
						commitSyncStarted();
						await commitGate;
					}
					await originalSync();
				};
			}
			return handle;
		});

		try {
			const publisher = getTelemetryInstallId(filePath);
			await commitStarted;
			let readerFinished = false;
			const reader = getTelemetryInstallId(filePath).then(() => {
				readerFinished = true;
			});
			await Bun.sleep(1_200);
			expect(readerFinished).toBe(false);
			releaseCommitSync();
			await Promise.all([publisher, reader]);
		} finally {
			releaseCommitSync();
			openSpy.mockRestore();
			linkSpy.mockRestore();
		}
	});

	it("preserves large bigint claim identities without numeric rounding", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const claimPath = `${filePath}.lock`;
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o600 });
		await fs.writeFile(claimPath, `stale|publishing|${Date.now() - 1}\n`, { mode: 0o600 });
		const statSpy = spyOn(fs, "stat").mockImplementation((async (
			file: Parameters<typeof fs.stat>[0],
			options: Parameters<typeof fs.stat>[1],
		) => {
			const actual = (await realStat(file, options as never)) as unknown as BigIntStats;
			if (String(file) !== claimPath) return actual as never;
			const huge = 2n ** 60n;
			return Object.assign(actual, { dev: huge, ino: huge + 1n });
		}) as never);

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("claim did not clear");
			expect(statSpy).toHaveBeenCalledWith(claimPath, { bigint: true });
			expect(await fs.readFile(claimPath, "utf8")).toContain("publishing");
		} finally {
			statSpy.mockRestore();
		}
	});
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
