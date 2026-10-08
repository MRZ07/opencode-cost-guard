import { randomUUID } from "node:crypto";

/** One-use receipts from native question events, bound to the exact extension. */
export function createApprovalGate({ now = Date.now } = {}) {
  const pending = new Map(), requests = new Map();
  const lifetime = 5 * 60_000;
  const key = (plan) => JSON.stringify(plan);
  const expire = () => {
    for (const [id, item] of pending) if (now() - item.createdAt >= lifetime) pending.delete(id);
    for (const [id, request] of requests) if (pending.get(request.key) !== request.item) requests.delete(id);
  };
  const prepare = (plan) => {
    expire();
    const id = key(plan);
    let item = pending.get(id);
    if (!item) {
      for (const [other, value] of pending) if (value.plan.callerSessionID === plan.callerSessionID) pending.delete(other);
      const nonce = randomUUID();
      item = { plan: structuredClone(plan), createdAt: now(), approved: false, question: {
        header: "Budget extension",
        question: `Approve budget extension ${nonce}: ${plan.scope} ${plan.targetSessionID}; add USD ${plan.usd ?? 0} and tokens ${plan.tokens ?? 0}?`,
        options: [{ label: "Approve", description: "Grant this exact one-time budget increment." },
          { label: "Reject", description: "Keep the current budget and stop or replan." }],
        multiple: false, custom: false,
      } };
      pending.set(id, item);
    }
    return { questions: [structuredClone(item.question)] };
  };
  const matches = (questions, item) => Array.isArray(questions) && questions.length === 1 &&
    questions[0]?.question === item.question.question && questions[0]?.multiple !== true &&
    questions[0]?.options?.length === 2 && questions[0].options[0]?.label === "Approve" &&
    questions[0].options[1]?.label === "Reject";
  const approve = (item, answers) => {
    if (Array.isArray(answers) && answers.length === 1 && Array.isArray(answers[0]) &&
      answers[0].length === 1 && answers[0][0] === "Approve") item.approved = true;
    else pending.delete(key(item.plan));
  };
  const event = ({ type, properties: info }) => {
    expire();
    if (type === "question.asked") {
      for (const [id, item] of pending) if (info.sessionID === item.plan.callerSessionID && matches(info.questions, item))
        requests.set(info.id, { key: id, item, sessionID: info.sessionID });
    } else if (type === "question.replied" || type === "question.rejected") {
      const request = requests.get(info.requestID), item = request?.item;
      requests.delete(info.requestID);
      if (!item || pending.get(request.key) !== item || request.sessionID !== info.sessionID) return;
      if (type === "question.rejected") pending.delete(request.key);
      else approve(item, info.answers);
    }
  };
  // The native after hook also handles SDK event delivery arriving after tool return.
  const afterQuestion = ({ sessionID, args }, output) => {
    expire();
    for (const item of pending.values()) if (sessionID === item.plan.callerSessionID && matches(args?.questions, item))
      approve(item, output?.metadata?.answers);
  };
  const consume = (plan) => {
    expire();
    const id = key(plan), item = pending.get(id);
    if (!item?.approved) throw new Error("cost-guard: exact budget extension requires a native user approval; requestExtension first, ask its question, then retry unchanged");
    pending.delete(id);
  };
  return { prepare, event, afterQuestion, consume };
}
