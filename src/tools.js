/**
 * Tool definitions and handlers for the Grok MCP Server.
 *
 * This module owns all MCP tool schemas and their implementation.
 * The main server module provides the HTTP client, the optional grok CLI
 * client, and configuration.
 */

import { cliModelArg, parseModelList } from "./cli-backend.js";

// -- Consensus Validation Protocol -------------------------------------------

const CVP_SYSTEM_PROMPT =
  "You are participating in a Consensus Validation Protocol (CVP). " +
  "Your role is to provide rigorous, evidence-based analysis through multiple rounds " +
  "of iterative refinement. Be thorough but concise. Avoid repetition — each round " +
  "must meaningfully advance the analysis. Stay objective and acknowledge uncertainty.";

/**
 * Returns the user prompt for a given CVP round.
 *
 * @param {string} topic  - The topic under analysis.
 * @param {number} round  - Current round (1-based).
 * @param {number} total  - Total number of rounds.
 * @returns {string}
 */
function cvpRoundPrompt(topic, round, total) {
  if (round === 1) {
    return (
      `Round ${round}/${total} — Initial Analysis\n\n` +
      `Analyze the following topic thoroughly and objectively. Identify the key claims, ` +
      `supporting evidence, areas of genuine uncertainty, and any common misconceptions.\n\n` +
      `Topic: ${topic}`
    );
  }
  if (round === total) {
    return (
      `Round ${round}/${total} — Final Synthesis\n\n` +
      `Synthesize your full multi-round analysis into a coherent, balanced conclusion. ` +
      `Clearly state: (1) points of strong consensus, (2) remaining uncertainties, and ` +
      `(3) your confidence level for each major conclusion. Be definitive where the evidence supports it.`
    );
  }

  // Intermediate rounds cycle through deepening strategies
  const strategies = [
    `Round ${round}/${total} — Counterarguments & Critique\n\n` +
      `Critically examine your previous analysis. What are the strongest counterarguments? ` +
      `Where might you be wrong or overconfident? What evidence supports alternative viewpoints?`,
    `Round ${round}/${total} — Evidence Assessment\n\n` +
      `Assess the quality and strength of evidence on all sides. Distinguish between what is ` +
      `well-established, what is probable, and what remains genuinely uncertain or contested.`,
    `Round ${round}/${total} — Perspectives & Edge Cases\n\n` +
      `Consider perspectives you have not yet explored. What would domain experts disagree on? ` +
      `Are there edge cases, regional differences, or temporal factors that affect the analysis?`,
  ];
  return strategies[(round - 2) % strategies.length];
}

/**
 * Formats the final CVP output as structured Markdown.
 */
function formatConsensusResult(topic, rounds, roundResults, model) {
  const lines = [
    `## Consensus Validation Protocol — Results`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Topic** | ${topic} |`,
    `| **Rounds completed** | ${rounds} |`,
    `| **Model** | ${model} |`,
    ``,
  ];

  for (const r of roundResults) {
    lines.push(`### Round ${r.round}`);
    lines.push(``);
    lines.push(r.content);
    lines.push(``);
  }

  return lines.join("\n");
}

// -- Tool definitions --------------------------------------------------------

/**
 * Returns the MCP tool schema array. Called on each ListTools request
 * so descriptions always reflect the current resolved model names.
 *
 * @param {{ chatModel: string, imageModel: string, backend?: string }} config
 * @returns {Array<object>}
 */
export function getToolDefinitions({ chatModel, imageModel, backend = "api" }) {
  const cli = backend === "cli";
  return [
    {
      name: "ask_grok",
      description:
        "Ask Grok a question and get a response. " +
        `Default model: ${chatModel}. ` +
        (cli
          ? "Runs through the signed-in grok CLI and uses the Grok subscription. " +
            "temperature, max_tokens, and top_p are unavailable on this backend. "
          : "Supports system prompts and sampling parameters (temperature, max_tokens, top_p). ") +
        "Run list_models to see all available model options.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The question or prompt to send to Grok",
          },
          system_prompt: {
            type: "string",
            description:
              "Optional system prompt to set Grok's behavior and persona for this request.",
          },
          model: {
            type: "string",
            description:
              `Chat model to use for this request. Defaults to "${chatModel}". ` +
              "Use list_models to see available chat models.",
          },
          temperature: {
            type: "number",
            description:
              "Sampling temperature (0-2). Lower values make output more deterministic. Default: model-dependent.",
          },
          max_tokens: {
            type: "number",
            description:
              "Maximum number of tokens to generate in the response.",
          },
          top_p: {
            type: "number",
            description:
              "Nucleus sampling: only consider tokens with cumulative probability up to this value (0-1).",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "generate_image",
      description: cli
        ? "Generate an image with Imagine through the signed-in grok CLI and save it locally. " +
          "Uses the Grok subscription. The model argument selects the chat model that calls Imagine, " +
          "not an image model id. There is no video tool."
        : "Generate an image using Grok's Aurora image model and save it to a local file. " +
          `Default model: ${imageModel}. ` +
          "Use the optional 'model' parameter to use a different image model.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Text description of the image to generate",
          },
          file_path: {
            type: "string",
            description:
              "Path where the image file should be saved. Relative paths resolve from cwd; " +
              "absolute paths must be within SAFE_WRITE_BASE_DIR (or cwd if unset). Example: images/output.png",
          },
          n: {
            type: "number",
            description: "Number of image variations to generate (1-10, default 1)",
          },
          model: {
            type: "string",
            description:
              `Image model to use for this request. Defaults to "${imageModel}". ` +
              "Use list_models to see available image models.",
          },
        },
        required: ["prompt", "file_path"],
      },
    },
    {
      name: "list_models",
      description: cli
        ? "List chat models available to the signed-in grok CLI. " +
          "Image generation uses Imagine and does not appear as its own model id. " +
          "Filter 'image' explains that. Filter 'chat' or 'all' lists CLI chat models."
        : "List all xAI models available to your account, including their IDs and capabilities. " +
          "Use this to discover which models you can pass to ask_grok or generate_image. " +
          "You can also filter by type: 'chat' for language models or 'image' for image generation.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "chat", "image"],
            description:
              "Filter models by capability. " +
              "'chat' returns language/reasoning models, " +
              "'image' returns image generation models, " +
              "'all' returns everything (default).",
          },
        },
        required: [],
      },
    },
    {
      name: "grok_consensus",
      description:
        "Runs a full iterative Consensus Validation Protocol (CVP) between Claude and Grok. " +
        "Returns a structured final summary. Default 3 rounds, maximum 10. " +
        "Supports custom round count via the 'rounds' argument." +
        (cli ? " Each round is a separate grok CLI turn against the subscription." : ""),
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic, claim, or question to analyze through the consensus protocol.",
          },
          rounds: {
            type: "number",
            description:
              "Number of analysis rounds to run. Omit for the default (3 rounds). " +
              "Higher values (up to 10) yield deeper analysis at the cost of latency.",
          },
        },
        required: ["topic"],
      },
    },
    {
      name: "grok_validate",
      description:
        "Runs a rigorous Validation Protocol on any artifact (code, plan, research, prompt, PR, architecture, etc.). " +
        "Produces a scored scorecard, identifies weaknesses, and returns an improved version. " +
        "Use this as your mandatory quality gate before shipping complex work. " +
        `Default model: ${chatModel}.` +
        (cli ? " Each round is a separate grok CLI turn against the subscription." : ""),
      inputSchema: {
        type: "object",
        properties: {
          artifact: {
            type: "string",
            description: "The artifact to validate (code, plan, research output, prompt, PR description, etc.)",
          },
          criteria: {
            type: "string",
            description: "Optional focus areas or custom evaluation criteria (e.g. 'security, performance, maintainability')",
          },
          reference: {
            type: "string",
            description: "Optional reference output from another model for side-by-side comparison",
          },
          rounds: {
            type: "number",
            description: "Number of validation rounds (1-10, default 5). Higher = deeper analysis.",
          },
          rubric: {
            type: "string",
            enum: ["balanced", "strict", "innovative", "security-focused"],
            description: "Evaluation style preset (default: balanced)",
          },
        },
        required: ["artifact"],
      },
    },
  ];
}

// -- Validation Protocol -----------------------------------------------------

const VALIDATE_DEFAULT_ROUNDS = 5;
const VALIDATE_MAX_ROUNDS = 10;

const VALIDATION_SYSTEM_PROMPT =
  "You are participating in a rigorous Validation Protocol powered by Grok. " +
  "Your role is to act as an independent, high-standard quality gate. " +
  "Be thorough, objective, and constructive. Always acknowledge uncertainty. " +
  "Never be sycophantic. Your goal is to make the final output materially better.";

function validationRoundPrompt(artifact, round, total, criteria, reference, rubric) {
  const rubricText = {
    balanced: "balanced evaluation across correctness, completeness, innovation, risk, and best practices",
    strict: "extremely strict — flag every potential issue, edge case, or ambiguity",
    innovative: "emphasize novelty, creativity, and forward-looking improvements while maintaining rigor",
    "security-focused": "heavy emphasis on security, privacy, attack surface, and compliance",
  }[rubric] || "balanced evaluation";

  if (round === 1) {
    return (
      `Round ${round}/${total} — Initial Validation\n\n` +
      `Artifact to validate:\n\n${artifact}\n\n` +
      (criteria ? `Focus criteria: ${criteria}\n\n` : "") +
      (reference ? `Reference output for comparison:\n\n${reference}\n\n` : "") +
      `Perform a ${rubricText}. Identify key strengths, critical weaknesses, missing elements, and risks.`
    );
  }

  if (round === total) {
    return (
      `Round ${round}/${total} — Final Synthesis & Improved Version\n\n` +
      `Synthesize all previous rounds into:\n` +
      `1. A clear scorecard (Correctness, Completeness, Innovation/Risk, Clarity, Best Practices — each scored 1-10 with rationale)\n` +
      `2. Top 3-5 critical issues with severity\n` +
      `3. A fully improved version of the original artifact (ready to copy-paste)\n` +
      `4. Your overall confidence and recommended next actions.\n\n` +
      `Be definitive where evidence supports it.`
    );
  }

  const strategies = [
    `Round ${round}/${total} — Counterarguments & Blind Spots\n\n` +
      `Critically challenge your own previous analysis. What are the strongest counterarguments or overlooked risks? Where might you be overconfident?`,
    `Round ${round}/${total} — Evidence & Edge Cases\n\n` +
      `Assess evidence quality for every claim. Explore edge cases, failure modes, regional/temporal factors, and long-term consequences.`,
    `Round ${round}/${total} — Comparison & Alternative Approaches\n\n` +
      (reference ? `Compare the artifact against the reference output. Which is stronger and why? ` : "") +
      `Propose superior alternative approaches or architectures.`,
  ];
  return strategies[(round - 2) % strategies.length];
}

function formatValidationResult(artifact, rounds, roundResults, model, criteria, rubric) {
  const lines = [
    `## Grok Validation Protocol — Results`,
    ``,
    `| Field              | Value |`,
    `|--------------------|-------|`,
    `| **Artifact Type**  | ${artifact.length > 80 ? "Long document / code" : "Short text"} |`,
    `| **Rounds**         | ${rounds} |`,
    `| **Model**          | ${model} |`,
    `| **Rubric**         | ${rubric || "balanced"} |`,
    criteria ? `| **Focus**          | ${criteria} |` : "",
    ``,
    `### Executive Scorecard`,
    ``,
    `| Dimension              | Score (1-10) | Rationale |`,
    `|------------------------|--------------|-----------|`,
    `| Correctness            | —            | (filled by Grok in final round) |`,
    `| Completeness           | —            | |`,
    `| Innovation / Risk      | —            | |`,
    `| Clarity & Communication| —            | |`,
    `| Best Practices         | —            | |`,
    `| **Overall**            | —            | |`,
    ``,
  ];

  for (const r of roundResults) {
    lines.push(`### Round ${r.round}`);
    lines.push(``);
    lines.push(r.content);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`**Next step recommendation**: Copy the improved version below into your workflow and re-validate if needed.`);

  return lines.join("\n");
}

/**
 * Formats `grok models` output for the list_models tool.
 *
 * @param {string} stdout
 * @param {string} filter
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function formatCliModelList(stdout, filter) {
  const imagineNote =
    "Image generation uses Imagine through the grok CLI. It is not a model id in this list. Call generate_image.";

  if (filter === "image") {
    return { content: [{ type: "text", text: imagineNote }] };
  }

  const { models } = parseModelList(stdout);
  if (models.length === 0) {
    const raw = String(stdout ?? "").trim();
    return {
      content: [{ type: "text", text: raw || "grok models returned no output." }],
    };
  }

  const lines = [
    `${models.length} chat model(s) available to the signed-in grok CLI:`,
    "",
  ];
  for (const model of models) {
    lines.push(`  ${model.id}  [chat]${model.isDefault ? " <- grok CLI default" : ""}`);
  }
  if (filter === "all") {
    lines.push("", imagineNote);
  }
  lines.push("", "To use one model for a call: pass model=\"<id>\" to ask_grok.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// -- Tool handlers -----------------------------------------------------------

/**
 * Creates tool handler functions bound to the provided server context.
 *
 * @param {object} ctx
 * @param {Function} ctx.xaiPost  - Authenticated POST to xAI API.
 * @param {Function} ctx.xaiGet   - Authenticated GET from xAI API.
 * @param {Function} [ctx.cli]    - Subscription CLI client used when config.backend is "cli".
 * @param {Function} ctx.safeWrite - Safe file writer.
 * @param {Function} ctx.buildFilePath - Multi-image path builder.
 * @param {Function} ctx.downloadBuffer - URL downloader.
 * @param {Function} ctx.resolve - path.resolve.
 * @param {object}   ctx.config  - Mutable config object with chatModel, imageModel, backend, etc.
 * @returns {Record<string, Function>}
 */
export function createToolHandlers(ctx) {
  const {
    xaiPost,
    xaiGet,
    cli,
    safeWrite,
    buildFilePath,
    downloadBuffer,
    resolve,
    config,
  } = ctx;

  const useCli = () => config.backend === "cli";

  function promptFromMessages(messages) {
    const dialogue = messages.filter((message) => message.role !== "system");
    if (dialogue.length === 1 && dialogue[0].role === "user") {
      return dialogue[0].content;
    }
    const transcript = dialogue
      .map((message) => {
        const role = message.role === "assistant" ? "Assistant" : "User";
        return `${role}:\n${message.content}`;
      })
      .join("\n\n");
    return `${transcript}\n\nRespond to the latest User message. Use the earlier turns as context.`;
  }

  async function completeChat(messages, { model, temperature, maxTokens, topP } = {}) {
    if (useCli()) {
      if (!cli?.complete) {
        throw new Error("GROK_BACKEND=cli but the grok CLI client is not configured");
      }
      const systemPrompt = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      return cli.complete({
        prompt: promptFromMessages(messages),
        systemPrompt,
        model: cliModelArg(model, config.chatModel),
      });
    }

    const requestBody = { model: model || config.chatModel, messages };
    if (typeof temperature === "number") requestBody.temperature = temperature;
    if (typeof maxTokens === "number") requestBody.max_tokens = maxTokens;
    if (typeof topP === "number") requestBody.top_p = topP;

    const data = await xaiPost("/chat/completions", requestBody);
    const messageContent = data?.choices?.[0]?.message?.content;
    if (typeof messageContent === "string") return messageContent;
    if (messageContent != null) return JSON.stringify(messageContent);
    return "No response";
  }

  // -- ask_grok --------------------------------------------------------------

  async function handleAskGrok(args) {
    if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
      throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
    }
    if (args.prompt.length > config.maxPromptLength) {
      throw new Error(
        `Prompt too long: ${args.prompt.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }

    if (
      useCli() &&
      (args.temperature != null || args.max_tokens != null || args.top_p != null)
    ) {
      throw new Error(
        "temperature, max_tokens, and top_p are unavailable when GROK_BACKEND=cli",
      );
    }

    const model =
      typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : config.chatModel;

    const messages = [];
    if (typeof args.system_prompt === "string" && args.system_prompt.trim()) {
      messages.push({ role: "system", content: args.system_prompt });
    }
    messages.push({ role: "user", content: args.prompt });

    const text = await completeChat(messages, {
      model,
      temperature: args.temperature,
      maxTokens: args.max_tokens,
      topP: args.top_p,
    });
    return { content: [{ type: "text", text }] };
  }

  // -- generate_image --------------------------------------------------------

  async function handleGenerateImage(args) {
    if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
      throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
    }
    if (args.prompt.length > config.maxPromptLength) {
      throw new Error(
        `Prompt too long: ${args.prompt.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }
    if (typeof args.file_path !== "string" || !args.file_path.trim()) {
      throw new Error("Invalid arguments: 'file_path' must be a non-empty string");
    }
    if (args.n != null && (!Number.isInteger(args.n) || args.n < 1)) {
      throw new Error("Invalid arguments: 'n' must be a positive integer");
    }

    const n = Math.min(Math.max(args.n ?? 1, 1), config.maxImageVariations);
    const model =
      typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : config.imageModel;

    if (useCli()) {
      if (!cli?.generateImages) {
        throw new Error("GROK_BACKEND=cli but the grok CLI client is not configured");
      }
      const imageModelRequested = /image|imagine|aurora/i.test(model);
      const agentModel = cliModelArg(
        imageModelRequested ? undefined : args.model,
        config.chatModel,
      );
      const images = await cli.generateImages({
        prompt: args.prompt,
        n,
        agentModel,
      });
      const saved = [];
      for (let i = 0; i < images.length; i++) {
        const dest = buildFilePath(args.file_path, i, images.length);
        await safeWrite(dest, images[i].bytes);
        saved.push(dest);
      }
      const lines = [
        `Generated and saved ${saved.length} image(s) with Imagine:`,
        saved.join("\n"),
      ];
      if (images.length < n) {
        lines.push("", `Requested ${n}, Imagine returned ${images.length}.`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const data = await xaiPost("/images/generations", {
      model,
      prompt: args.prompt,
      n,
    });

    const images = Array.isArray(data?.data) ? data.data : [];
    if (images.length === 0) {
      throw new Error("xAI API did not return any images");
    }

    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const imageUrl = images[i]?.url;
      if (typeof imageUrl !== "string" || !imageUrl) {
        throw new Error(`xAI API returned an invalid image URL at index ${i}`);
      }

      const buffer = await downloadBuffer(imageUrl);
      const dest = buildFilePath(args.file_path, i, images.length);
      await safeWrite(dest, buffer);
      saved.push(dest);
    }

    return {
      content: [
        {
          type: "text",
          text: `Generated and saved ${saved.length} image(s):\n${saved.join("\n")}`,
        },
      ],
    };
  }

  // -- list_models -----------------------------------------------------------

  async function handleListModels(args) {
    const filter = args?.filter ?? "all";
    if (!["all", "chat", "image"].includes(filter)) {
      throw new Error("Invalid arguments: 'filter' must be 'all', 'chat', or 'image'");
    }

    if (useCli()) {
      if (!cli?.listModels) {
        throw new Error("GROK_BACKEND=cli but the grok CLI client is not configured");
      }
      return formatCliModelList(await cli.listModels(), filter);
    }

    const data = await xaiGet("/models");
    const models = Array.isArray(data?.data) ? data.data : [];

    if (models.length === 0) {
      return { content: [{ type: "text", text: "No models returned by the xAI API." }] };
    }

    const isImageModel = (id) => /image|imagine|aurora/i.test(id);

    const filtered = models.filter((m) => {
      if (filter === "all") return true;
      const isImg = isImageModel(m.id ?? "");
      return filter === "image" ? isImg : !isImg;
    });

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No ${filter} models found. Try filter: "all" to see everything.`,
          },
        ],
      };
    }

    filtered.sort((a, b) => {
      const aImg = isImageModel(a.id ?? "");
      const bImg = isImageModel(b.id ?? "");
      if (aImg !== bImg) return aImg ? 1 : -1;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });

    const lines = [
      `${filtered.length} model(s) available${filter !== "all" ? ` (filter: ${filter})` : ""}:`,
      "",
    ];

    for (const m of filtered) {
      const id = m.id ?? "unknown";
      const type = isImageModel(id) ? "image" : "chat";
      const isDefaultChat = id === config.chatModel;
      const isDefaultImage = id === config.imageModel;
      const defaultTag = isDefaultChat
        ? " <- current default (chat)"
        : isDefaultImage
          ? " <- current default (image)"
          : "";
      lines.push(`  ${id}  [${type}]${defaultTag}`);
    }

    lines.push("");
    lines.push(`To change the default: set GROK_CHAT_MODEL or GROK_IMAGE_MODEL env vars.`);
    lines.push(`To use once: pass model="<id>" to ask_grok or generate_image.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // -- grok_consensus --------------------------------------------------------

  const CVP_DEFAULT_ROUNDS = 3;
  const CVP_MAX_ROUNDS = 10;

  async function handleGrokConsensus(args) {
    if (!args || typeof args.topic !== "string" || !args.topic.trim()) {
      throw new Error("Invalid arguments: 'topic' must be a non-empty string");
    }
    if (args.topic.length > config.maxPromptLength) {
      throw new Error(
        `Topic too long: ${args.topic.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }
    if (
      args.rounds != null &&
      (!Number.isInteger(args.rounds) || args.rounds < 1 || args.rounds > CVP_MAX_ROUNDS)
    ) {
      throw new Error(
        `Invalid arguments: 'rounds' must be an integer between 1 and ${CVP_MAX_ROUNDS}`,
      );
    }

    const topic = args.topic.trim();
    const numRounds = args.rounds ?? CVP_DEFAULT_ROUNDS;
    const model = config.chatModel;

    // Build conversation incrementally — Grok sees the full history each round.
    const messages = [{ role: "system", content: CVP_SYSTEM_PROMPT }];

    const roundResults = [];

    for (let round = 1; round <= numRounds; round++) {
      const userPrompt = cvpRoundPrompt(topic, round, numRounds);
      messages.push({ role: "user", content: userPrompt });

      const content = await completeChat(messages, { model, temperature: 0.7 });
      messages.push({ role: "assistant", content });
      roundResults.push({ round, content });
    }

    const text = formatConsensusResult(topic, numRounds, roundResults, model);
    return { content: [{ type: "text", text }] };
  }

  // -- grok_validate ---------------------------------------------------------

  async function handleGrokValidate(args) {
    if (!args || typeof args.artifact !== "string" || !args.artifact.trim()) {
      throw new Error("Invalid arguments: 'artifact' must be a non-empty string");
    }
    if (args.artifact.length > config.maxPromptLength) {
      throw new Error(
        `Artifact too long: ${args.artifact.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }
    if (
      args.rounds != null &&
      (!Number.isInteger(args.rounds) || args.rounds < 1 || args.rounds > VALIDATE_MAX_ROUNDS)
    ) {
      throw new Error(
        `Invalid arguments: 'rounds' must be an integer between 1 and ${VALIDATE_MAX_ROUNDS}`,
      );
    }
    if (args.rubric && !["balanced", "strict", "innovative", "security-focused"].includes(args.rubric)) {
      throw new Error("Invalid arguments: 'rubric' must be one of: balanced, strict, innovative, security-focused");
    }

    const artifact = args.artifact.trim();
    const numRounds = args.rounds ?? VALIDATE_DEFAULT_ROUNDS;
    const model = config.chatModel;
    const rubric = args.rubric || "balanced";
    const criteria = args.criteria?.trim() || null;
    const reference = args.reference?.trim() || null;

    const messages = [{ role: "system", content: VALIDATION_SYSTEM_PROMPT }];
    const roundResults = [];

    for (let round = 1; round <= numRounds; round++) {
      const userPrompt = validationRoundPrompt(artifact, round, numRounds, criteria, reference, rubric);
      messages.push({ role: "user", content: userPrompt });

      const content = await completeChat(messages, { model, temperature: 0.65 });
      messages.push({ role: "assistant", content });
      roundResults.push({ round, content });
    }

    const text = formatValidationResult(artifact, numRounds, roundResults, model, criteria, rubric);
    return { content: [{ type: "text", text }] };
  }

  // -- Handler map -----------------------------------------------------------

  return {
    ask_grok: handleAskGrok,
    generate_image: handleGenerateImage,
    list_models: handleListModels,
    grok_consensus: handleGrokConsensus,
    grok_validate: handleGrokValidate,
  };
}
