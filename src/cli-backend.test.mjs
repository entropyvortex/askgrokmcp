import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import {
  buildChildEnv,
  checkCliReady,
  cliModelArg,
  createCliClient,
  imageArgs,
  imageInstruction,
  parseCliResult,
  parseModelList,
  runGrok,
  textArgs,
} from "./cli-backend.js";
import { createToolHandlers } from "./tools.js";

const MODEL_LIST = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
`;

function fakeSpawn(handler) {
  return (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    };
    queueMicrotask(() => {
      Promise.resolve(handler({ bin, args, opts, child })).catch((error) => {
        child.emit("error", error);
      });
    });
    return child;
  };
}

function emitResult(child, { stdout = "", stderr = "", code = 0 } = {}) {
  if (stdout) child.stdout.emit("data", Buffer.from(stdout));
  if (stderr) child.stderr.emit("data", Buffer.from(stderr));
  child.emit("exit", code, null);
}

describe("buildChildEnv", () => {
  it("removes API key variables and disables the auto updater", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      XAI_API_KEY: "xai-secret",
      GROK_CODE_XAI_API_KEY: "also-secret",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/me");
    assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
    assert.equal("XAI_API_KEY" in env, false);
    assert.equal("GROK_CODE_XAI_API_KEY" in env, false);
  });
});

describe("cliModelArg", () => {
  it("omits the subscription placeholder labels", () => {
    assert.equal(cliModelArg(undefined, "grok CLI default"), undefined);
    assert.equal(cliModelArg("Imagine", "grok-4.7"), undefined);
  });

  it("prefers an explicit chat model", () => {
    assert.equal(cliModelArg("grok-4.5", "grok CLI default"), "grok-4.5");
  });
});

describe("parseModelList", () => {
  it("reads the default marker and the available ids", () => {
    const parsed = parseModelList(MODEL_LIST);
    assert.equal(parsed.defaultModel, "grok-4.7");
    assert.deepEqual(
      parsed.models.map((model) => model.id),
      ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"],
    );
    assert.equal(parsed.models[0].isDefault, true);
    assert.equal(parsed.models[1].isDefault, false);
  });
});

describe("parseCliResult", () => {
  it("reads the current result object", () => {
    const parsed = parseCliResult(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello",
      session_id: "abc",
    }));
    assert.equal(parsed.text, "hello");
    assert.equal(parsed.sessionId, "abc");
  });

  it("reads structured_output.answer and the older text field", () => {
    assert.equal(
      parseCliResult(JSON.stringify({
        type: "result",
        structured_output: { answer: "from schema" },
        result: "ignored",
      })).text,
      "from schema",
    );
    assert.equal(
      parseCliResult(JSON.stringify({ text: "legacy", sessionId: "s1" })).sessionId,
      "s1",
    );
  });

  it("prefers the result event when stdout is newline-delimited JSON", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", subtype: "success", result: "final" }),
    ].join("\n");
    assert.equal(parseCliResult(stdout).text, "final");
  });

  it("throws on an error subtype", () => {
    assert.throws(
      () => parseCliResult(JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "boom",
      })),
      /grok CLI error: boom/,
    );
  });
});

describe("command arguments", () => {
  it("builds a tool-denied text command", () => {
    const args = textArgs({
      promptFile: "/tmp/prompt.txt",
      cwd: "/tmp/scratch",
      model: "grok-4.7",
      systemPrompt: "Be brief",
      maxTurns: 2,
    });
    assert.ok(args.includes("--permission-mode"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(args.includes("--json-schema"));
    assert.equal(args[args.indexOf("--prompt-file") + 1], "/tmp/prompt.txt");
    assert.equal(args[args.indexOf("-m") + 1], "grok-4.7");
    assert.equal(args.includes("--always-approve"), false);
  });

  it("builds an Imagine command that allows only image_gen", () => {
    const args = imageArgs({
      promptFile: "/tmp/prompt.txt",
      cwd: "/tmp/scratch",
      maxTurns: 4,
    });
    assert.equal(args[args.indexOf("--tools") + 1], "image_gen");
    assert.match(args[args.indexOf("--disallowed-tools") + 1], /video_gen/);
    assert.ok(args.includes("--always-approve"));
    assert.equal(args.includes("--json-schema"), false);
    assert.match(imageInstruction("a cat", 2), /image_gen/);
    assert.match(imageInstruction("a cat", 2), /<<<IMAGE_PROMPT>>>\na cat\n/);
  });
});

describe("runGrok", () => {
  it("captures stdout and strips the API key from the child env", async () => {
    let seen;
    const spawnImpl = fakeSpawn(({ args, opts, child }) => {
      seen = { args, env: opts.env };
      emitResult(child, { stdout: "ok\n" });
    });
    const result = await runGrok("grok", ["--version"], {
      spawnImpl,
      env: buildChildEnv({ PATH: "/bin", XAI_API_KEY: "secret" }),
      timeoutMs: 1_000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "ok\n");
    assert.deepEqual(seen.args, ["--version"]);
    assert.equal(seen.env.XAI_API_KEY, undefined);
    assert.equal(seen.env.PATH, "/bin");
  });

  it("rejects when the child exceeds the timeout", async () => {
    const spawnImpl = fakeSpawn(() => {
      // Never exits on its own.
    });
    await assert.rejects(
      () => runGrok("grok", ["-p", "hi"], { spawnImpl, timeoutMs: 30, env: { PATH: "/bin" } }),
      { code: "ETIMEDOUT" },
    );
  });
});

describe("checkCliReady", () => {
  it("fails when the binary is missing", async () => {
    const error = new Error("spawn grok ENOENT");
    error.code = "ENOENT";
    const spawnImpl = () => {
      throw error;
    };
    const status = await checkCliReady({ bin: "grok", spawnImpl, env: {} });
    assert.equal(status.ok, false);
    assert.match(status.message, /not found/);
  });

  it("fails when auth.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "askgrok-auth-"));
    try {
      const spawnImpl = fakeSpawn(({ child }) => {
        emitResult(child, { stdout: "grok 1.0.46\n" });
      });
      const status = await checkCliReady({
        bin: "grok",
        spawnImpl,
        env: {},
        authPath: join(dir, "auth.json"),
      });
      assert.equal(status.ok, false);
      assert.match(status.message, /grok login/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes when version succeeds and the auth file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "askgrok-auth-"));
    try {
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, "{}\n");
      const spawnImpl = fakeSpawn(({ child }) => {
        emitResult(child, { stdout: "grok 1.0.46\n" });
      });
      const status = await checkCliReady({ bin: "grok", spawnImpl, env: {}, authPath });
      assert.equal(status.ok, true);
      assert.match(status.version, /1\.0\.46/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createCliClient", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    XAI_API_KEY: "secret",
    GROK_CODE_XAI_API_KEY: "secret-2",
  };

  it("returns the parsed answer and does not pass the API key", async () => {
    const spawnImpl = fakeSpawn(async ({ args, opts, child }) => {
      assert.equal(opts.env.XAI_API_KEY, undefined);
      assert.equal(opts.env.GROK_CODE_XAI_API_KEY, undefined);
      const prompt = await readFile(args[args.indexOf("--prompt-file") + 1], "utf8");
      assert.equal(prompt, "What is 2+2?");
      assert.equal(args[args.indexOf("--system-prompt-override") + 1], "Be brief");
      emitResult(child, {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          structured_output: { answer: "4" },
        }),
      });
    });
    const client = createCliClient({ bin: "grok", spawnImpl, env, textTimeoutMs: 1_000 });
    const text = await client.complete({
      prompt: "What is 2+2?",
      systemPrompt: "Be brief",
      model: "grok-4.7",
    });
    assert.equal(text, "4");
  });

  it("collects an image written in the temp directory", async () => {
    const spawnImpl = fakeSpawn(async ({ args, opts, child }) => {
      assert.equal(args[args.indexOf("--tools") + 1], "image_gen");
      assert.equal(opts.cwd.includes("askgrok-"), true);
      await mkdir(join(opts.cwd, "images"), { recursive: true });
      await writeFile(join(opts.cwd, "images", "1.png"), Buffer.from("png-bytes"));
      emitResult(child, {
        stdout: JSON.stringify({ type: "result", subtype: "success", result: "saved images/1.png" }),
      });
    });
    const client = createCliClient({ bin: "grok", spawnImpl, env, imageTimeoutMs: 1_000 });
    const images = await client.generateImages({ prompt: "a red boat", n: 1 });
    assert.equal(images.length, 1);
    assert.equal(images[0].bytes.toString(), "png-bytes");
  });

  it("reads an image saved under the grok home and ignores other paths", async () => {
    const grokHome = await mkdtemp(join(tmpdir(), "askgrok-home-"));
    const outside = await mkdtemp(join(tmpdir(), "askgrok-out-"));
    const imagePath = join(grokHome, "sessions", "shot.png");
    const outsidePath = join(outside, "secret.png");
    await mkdir(join(grokHome, "sessions"), { recursive: true });
    await writeFile(imagePath, Buffer.from("from-home"));
    await writeFile(outsidePath, Buffer.from("secret"));
    try {
      const spawnImpl = fakeSpawn(({ child }) => {
        emitResult(child, {
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            result: `saved ${imagePath} and ${outsidePath}`,
          }),
        });
      });
      const client = createCliClient({
        bin: "grok",
        spawnImpl,
        env: { ...env, GROK_HOME: grokHome },
        imageTimeoutMs: 1_000,
      });
      const images = await client.generateImages({ prompt: "a lighthouse", n: 2 });
      assert.equal(images.length, 1);
      assert.equal(images[0].bytes.toString(), "from-home");
    } finally {
      await rm(grokHome, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("returns grok models stdout", async () => {
    const spawnImpl = fakeSpawn(({ args, child }) => {
      assert.deepEqual(args, ["models"]);
      emitResult(child, { stdout: MODEL_LIST });
    });
    const client = createCliClient({ bin: "grok", spawnImpl, env, textTimeoutMs: 1_000 });
    assert.match(await client.listModels(), /grok-4\.7/);
  });
});

describe("CLI tool handlers", () => {
  function handlersWith(cli, writes = []) {
    return createToolHandlers({
      xaiPost: async () => {
        throw new Error("API backend was called");
      },
      xaiGet: async () => {
        throw new Error("API backend was called");
      },
      cli,
      safeWrite: async (dest, data) => {
        writes.push({ dest, data });
      },
      buildFilePath: (basePath, index, total) => {
        if (total <= 1) return resolve(basePath);
        return resolve(`${basePath}.${index + 1}`);
      },
      downloadBuffer: async () => {
        throw new Error("download was called");
      },
      resolve,
      config: {
        backend: "cli",
        chatModel: "grok CLI default",
        imageModel: "Imagine",
        maxPromptLength: 1_000,
        maxImageVariations: 10,
      },
    });
  }

  it("rejects sampling parameters", async () => {
    const { ask_grok: askGrok } = handlersWith({});
    await assert.rejects(
      () => askGrok({ prompt: "hi", temperature: 0 }),
      /unavailable when GROK_BACKEND=cli/,
    );
  });

  it("sends the system prompt and returns the CLI answer", async () => {
    let request;
    const { ask_grok: askGrok } = handlersWith({
      complete: async (value) => {
        request = value;
        return "pong";
      },
    });
    const result = await askGrok({ prompt: "ping", system_prompt: "tester" });
    assert.equal(result.content[0].text, "pong");
    assert.equal(request.prompt, "ping");
    assert.equal(request.systemPrompt, "tester");
    assert.equal(request.model, undefined);
  });

  it("saves Imagine bytes through safeWrite", async () => {
    const writes = [];
    const { generate_image: generateImage } = handlersWith({
      generateImages: async () => [{ bytes: Buffer.from("img-a") }, { bytes: Buffer.from("img-b") }],
    }, writes);
    const result = await generateImage({ prompt: "two cats", file_path: "images/cat.png", n: 2 });
    assert.equal(writes.length, 2);
    assert.equal(writes[0].data.toString(), "img-a");
    assert.match(result.content[0].text, /Imagine/);
    assert.match(result.content[0].text, /cat\.png/);
  });

  it("lists CLI models and explains Imagine for the image filter", async () => {
    const { list_models: listModels } = handlersWith({
      listModels: async () => MODEL_LIST,
    });
    const all = await listModels({ filter: "all" });
    assert.match(all.content[0].text, /grok-4\.7/);
    assert.match(all.content[0].text, /Imagine/);
    const images = await listModels({ filter: "image" });
    assert.match(images.content[0].text, /Imagine/);
    assert.equal(images.content[0].text.includes("grok-4.6"), false);
  });

  it("carries consensus history into the next CLI turn", async () => {
    const prompts = [];
    const { grok_consensus: consensus } = handlersWith({
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        return `analysis ${prompts.length}`;
      },
    });
    const result = await consensus({ topic: "fusion", rounds: 2 });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /fusion/);
    assert.match(prompts[1], /analysis 1/);
    assert.match(result.content[0].text, /Round 2/);
  });
});

describe("API tool handlers", () => {
  it("still posts chat completions when the backend is api", async () => {
    let body;
    const { ask_grok: askGrok } = createToolHandlers({
      xaiPost: async (_path, value) => {
        body = value;
        return { choices: [{ message: { content: "api-answer" } }] };
      },
      xaiGet: async () => ({ data: [] }),
      safeWrite: async () => {},
      buildFilePath: (value) => value,
      downloadBuffer: async () => Buffer.from(""),
      resolve,
      config: {
        backend: "api",
        chatModel: "grok-4.3",
        imageModel: "grok-imagine-image-quality",
        maxPromptLength: 1_000,
        maxImageVariations: 10,
      },
    });
    const result = await askGrok({ prompt: "hi", temperature: 0 });
    assert.equal(result.content[0].text, "api-answer");
    assert.equal(body.model, "grok-4.3");
    assert.equal(body.temperature, 0);
    assert.equal(body.messages[0].content, "hi");
  });
});

describe("plugin manifest", () => {
  it("points the MCP server at the CLI launcher", async () => {
    const plugin = JSON.parse(await readFile(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    const marketplace = JSON.parse(await readFile(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
    assert.equal(plugin.name, "askgrok");
    assert.equal(plugin.mcpServers.grok.env.GROK_BACKEND, "cli");
    assert.match(plugin.mcpServers.grok.args[0], /plugin-start\.mjs$/);
    assert.equal(marketplace.plugins[0].name, plugin.name);
    assert.equal(marketplace.plugins[0].source, ".");
  });
});
