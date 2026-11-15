/**
 * Alert runner — a monitoring alert answered by a command, in the alert's own thread.
 *
 * A Grafana alert posted by a Discord webhook is not a person asking the bot something:
 * its text is a vendor's, and a model session with the bot's tools must never take it
 * as a prompt. So an alert never reaches the model. With ALERT_CHANNELS, ALERT_WEBHOOKS
 * and ALERT_RUNNER all set, a message in one of those channels whose webhook id is
 * listed is handed to ALERT_RUNNER (the routine runner's contract, lib/routine-runner.js:
 * stdin { identifier, title, description }; exit 0 answers, exit 3 declines). The answer
 * is posted in a thread on the alert. Every other message in those channels is treated as
 * it would be without this: a webhook is a bot, and ALLOWED_BOTS does not name it.
 *
 * Runs go one at a time, in arrival order: each can be a long model run of its own,
 * and a burst of alerts must not start a burst of them.
 */
const ids = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The three settings together, or null when none is set. A partial set is a problem, never a guess. */
function parseAlertConfig(env, parseCommand) {
  const channels = ids(env.ALERT_CHANNELS);
  const webhooks = ids(env.ALERT_WEBHOOKS);
  const command = parseCommand(env.ALERT_RUNNER);
  const set = [channels.length > 0, webhooks.length > 0, Boolean(command)];
  if (!set.some(Boolean)) return { config: null, problem: null };
  if (!set.every(Boolean)) return { config: null, problem: "ALERT_CHANNELS, ALERT_WEBHOOKS and ALERT_RUNNER must be set together; alert runner off" };
  return { config: { channels, webhooks, command }, problem: null };
}

/** True only for a listed webhook posting in a listed channel. A person, or any other bot or webhook, is not an alert. */
function isAlert(msg, config) {
  if (!config || !msg?.webhookId) return false;
  return config.channels.includes(msg.channelId) && config.webhooks.includes(msg.webhookId);
}

/** The alert as the runner receives it: its embed title, and the message body with every embed's text. */
function alertInput(msg) {
  const embeds = msg.embeds ?? [];
  const embedText = embeds.map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join("\n"));
  const content = msg.content ?? "";
  return {
    identifier: msg.id,
    title: embeds.find((e) => e.title)?.title ?? content.split("\n").find((l) => l.trim()) ?? "",
    description: [content, ...embedText].filter(Boolean).join("\n"),
  };
}

/** A thread name Discord accepts: 1 to 100 characters. */
function threadName(title) {
  const name = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  return name || "Alert triage";
}

/**
 * @param {Function} o.run    (input) => Promise<string|null>, the routine runner
 * @param {Function} o.split  (text) => string[], the bot's Discord chunking
 * @returns {{ enqueue(msg): void, idle(): Promise<void> }}
 */
function createAlertQueue({ run, split, log }) {
  let tail = Promise.resolve();
  const handle = async (msg) => {
    const input = alertInput(msg);
    let answer;
    try {
      answer = await run(input);
    } catch (err) {
      log?.error({ message: msg.id, err: err.message }, "Alert runner failed");
      answer = `The alert runner failed, so this alert was not triaged: ${String(err.message).slice(0, 400)}`;
    }
    if (!answer) { log?.info({ message: msg.id }, "Alert runner declined the alert"); return; }
    const thread = msg.hasThread && msg.thread ? msg.thread : await msg.startThread({ name: threadName(input.title), autoArchiveDuration: 1440 });
    for (const chunk of split(answer)) await thread.send({ content: chunk, allowedMentions: { parse: [] } });
    log?.info({ message: msg.id, thread: thread.id }, "Alert answered in its thread");
  };
  return {
    enqueue(msg) {
      tail = tail.then(() => handle(msg)).catch((err) => log?.error({ message: msg?.id, err: err.message }, "Alert could not be answered on Discord"));
    },
    idle: () => tail,
  };
}

module.exports = { parseAlertConfig, isAlert, alertInput, threadName, createAlertQueue };
