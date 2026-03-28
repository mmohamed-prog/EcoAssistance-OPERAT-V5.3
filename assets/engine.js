/* EcoAssistance OPERAT — V5 hybride
   Moteur expert + parcours adaptatif + restitution publique simplifiée
*/

class EcoAssistanceEngine {
  constructor({ cases, services, flow, publicOutputs, config = {} }) {
    this.cases = Array.isArray(cases) ? cases : [];
    this.services = services || {};
    this.flow = flow || {};
    this.publicOutputs = publicOutputs || {};
    this.publicOutputIndex = this.buildPublicOutputIndex(this.publicOutputs);

    this.config = {
      secondaryGapMax: 2,
      minScoreToKeep: 1,
      maxSecondary: 2,
      maxQuestionsAfterNeed: 6,
      ...config
    };
  }

  static async create({
    casesUrl = "./data/cases.json",
    servicesUrl = "./data/services.json",
    flowUrl = "./data/adaptive-flow.json",
    publicOutputsUrl = "./data/public-outputs.json",
    config = {}
  } = {}) {
    const [casesRes, servicesRes, flowRes, publicOutputsRes] = await Promise.all([
      fetch(casesUrl),
      fetch(servicesUrl),
      fetch(flowUrl),
      fetch(publicOutputsUrl)
    ]);

    if (!casesRes.ok) throw new Error(`Impossible de charger cases.json (${casesRes.status})`);
    if (!servicesRes.ok) throw new Error(`Impossible de charger services.json (${servicesRes.status})`);
    if (!flowRes.ok) throw new Error(`Impossible de charger adaptive-flow.json (${flowRes.status})`);
    if (!publicOutputsRes.ok) throw new Error(`Impossible de charger public-outputs.json (${publicOutputsRes.status})`);

    const [cases, services, flow, publicOutputs] = await Promise.all([
      casesRes.json(),
      servicesRes.json(),
      flowRes.json(),
      publicOutputsRes.json()
    ]);

    return new EcoAssistanceEngine({
      cases,
      services,
      flow,
      publicOutputs,
      config
    });
  }

  buildPublicOutputIndex(publicOutputs = {}) {
    const index = {};
    Object.values(publicOutputs).forEach((output) => {
      const internalCases = Array.isArray(output.internal_cases) ? output.internal_cases : [];
      internalCases.forEach((caseId) => {
        index[caseId] = output.id;
      });
    });
    return index;
  }

  getPublicOutputIdForCase(caseId) {
    return this.publicOutputIndex?.[caseId] || null;
  }

  getPublicOutputById(outputId) {
    if (!outputId) return null;
    return this.publicOutputs?.[outputId] || null;
  }

  getPublicOutputForCase(caseId) {
    const outputId = this.getPublicOutputIdForCase(caseId);
    return this.getPublicOutputById(outputId);
  }

  getQuestion(questionId) {
    return this.flow?.questions?.[questionId] || null;
  }

  getEntryNeedQuestion() {
    return this.getQuestion("need");
  }

  getBaseQuestionPool(needValue) {
    const entryMap = this.flow?.entry_map || {};
    const pool = entryMap[needValue] || entryMap["blocage"] || [];
    return Array.from(new Set(pool));
  }

  caseMatchesKnownAnswers(caseDef, userState) {
    const conditions = caseDef.conditions || {};
    for (const [field, allowedValues] of Object.entries(conditions)) {
      const userVal = userState[field];
      if (userVal == null) continue;
      if (!Array.isArray(allowedValues)) continue;
      if (!allowedValues.includes(userVal)) return false;
    }
    return true;
  }

  getActiveCases(userState = {}) {
    return this.cases.filter((caseDef) => this.caseMatchesKnownAnswers(caseDef, userState));
  }

  scoreCase(caseDef, userState = {}) {
    const weights = caseDef.weights || {};
    const conditions = caseDef.conditions || {};
    let score = 0;

    for (const [field, weight] of Object.entries(weights)) {
      const userVal = userState[field];
      if (userVal == null) continue;
      const allowedValues = conditions[field] || [];
      if (Array.isArray(allowedValues) && allowedValues.includes(userVal)) {
        score += Number(weight) || 0;
      }
    }
    return score;
  }

  applyExclusions(scoredCases) {
    const byId = new Map(scoredCases.map((c) => [c.id, c]));
    return scoredCases.filter((candidate) => {
      const exclusions = Array.isArray(candidate.exclusions) ? candidate.exclusions : [];
      for (const excludedId of exclusions) {
        const excludedCase = byId.get(excludedId);
        if (excludedCase && excludedCase.score >= candidate.score) return false;
      }
      return true;
    });
  }

  resolveDiagnosis(userState = {}) {
    const preselected = this.getActiveCases(userState)
      .map((caseDef) => ({
        ...caseDef,
        score: this.scoreCase(caseDef, userState)
      }))
      .filter((c) => c.score >= this.config.minScoreToKeep)
      .sort((a, b) => b.score - a.score);

    const filtered = this.applyExclusions(preselected).sort((a, b) => b.score - a.score);
    const primary = filtered[0] || null;
    const secondary = primary
      ? filtered
          .filter((c) => c.id !== primary.id && c.score >= primary.score - this.config.secondaryGapMax)
          .slice(0, this.config.maxSecondary)
      : [];

    const confidence = this.computeConfidence(primary, secondary, filtered);

    return { primary, secondary, confidence, all: filtered };
  }

  computeConfidence(primary, secondary, allCases) {
    if (!primary) return "faible";
    if (allCases.length === 1) return "élevée";
    if (!secondary.length) return "élevée";
    const gap = primary.score - secondary[0].score;
    if (gap >= 4) return "élevée";
    if (gap >= 2) return "moyenne";
    return "faible";
  }

  getService(serviceId) {
    return this.services?.[serviceId] || null;
  }

  buildPublicResult(diagnosis) {
    if (!diagnosis?.primary) {
      const fallbackService = this.getService("cadrage_tertiaire") || this.getService("relecture_operat") || null;
      return {
        outputId: null,
        title: "Blocage non tranché à ce stade",
        headline: "Le diagnostic reste encore trop ambigu pour être tranché proprement.",
        cause: "Le cas semble mélanger plusieurs causes ou manquer encore d’éléments discriminants.",
        screen: "Relecture transversale du dossier",
        action: "Faire une revue structurée du périmètre, des données et du déclaratif.",
        service: fallbackService,
        tone: "high_priority",
        tags: ["Diagnostic", "Clarification"],
        confidence: "faible",
        secondary: [],
        primaryId: null
      };
    }

    const mainCase = diagnosis.primary;
    const publicOutput = this.getPublicOutputForCase(mainCase.id);

    if (!publicOutput) {
      const service = this.getService(mainCase.service);
      return {
        outputId: null,
        title: mainCase.label_public || "Diagnostic métier",
        headline: mainCase.label_public || "Un scénario principal a été détecté.",
        cause: mainCase.cause,
        screen: mainCase.screen,
        action: mainCase.action,
        service,
        tone: "medium_priority",
        tags: [],
        confidence: diagnosis.confidence,
        secondary: diagnosis.secondary.map((c) => ({
          id: c.id,
          title: c.label_public,
          labelExpert: c.label_expert,
          score: c.score,
          outputId: this.getPublicOutputIdForCase(c.id)
        })),
        primaryId: mainCase.id
      };
    }

    const service = this.getService(publicOutput.service);
    const secondaryMacroOutputs = [];
    const seen = new Set();

    diagnosis.secondary.forEach((secondaryCase) => {
      const secOutputId = this.getPublicOutputIdForCase(secondaryCase.id);
      if (!secOutputId) return;
      if (secOutputId === publicOutput.id) return;
      if (seen.has(secOutputId)) return;

      const secOutput = this.getPublicOutputById(secOutputId);
      if (!secOutput) return;

      seen.add(secOutputId);
      secondaryMacroOutputs.push({
        id: secOutput.id,
        title: secOutput.title,
        headline: secOutput.headline
      });
    });

    return {
      outputId: publicOutput.id,
      title: publicOutput.title,
      headline: publicOutput.headline,
      cause: publicOutput.cause,
      screen: publicOutput.screen,
      action: publicOutput.action,
      service,
      tone: publicOutput.tone || "medium_priority",
      tags: Array.isArray(publicOutput.tags) ? publicOutput.tags : [],
      confidence: diagnosis.confidence,
      secondary: secondaryMacroOutputs,
      primaryId: mainCase.id
    };
  }

  getScreenNotes(caseId) {
    const map = {
      decl_incomplete_validation: [
        "Vérifier le statut réel de validation.",
        "Confirmer que la déclaration n’est pas seulement saisie, mais finalisée.",
        "Relire les données annuelles structurantes."
      ],
      decl_partial_data_gap: [
        "Contrôler les données manquantes ou partielles.",
        "Vérifier la cohérence du dossier avant reprise.",
        "Éviter d’interpréter trop tôt les sorties."
      ],
      decl_not_validated_status_unclear: [
        "Confirmer le statut exact du dossier.",
        "Vérifier si la validation a réellement été finalisée.",
        "Ne pas interpréter le reste tant que ce point n’est pas levé."
      ],
      objectifs_absents_non_valide: [
        "Confirmer la validation du déclaratif.",
        "Revérifier ensuite la restitution des objectifs.",
        "Ne pas conclure avant stabilisation du dossier."
      ],
      objectifs_absents_reference_fragile: [
        "Relire l’année de référence retenue.",
        "Contrôler les usages pris en compte.",
        "Vérifier la cohérence globale de la base."
      ],
      objectifs_absents_docs_weak: [
        "Sécuriser d’abord le socle documentaire.",
        "Relire ensuite l’écran objectifs.",
        "Éviter d’attribuer trop vite le sujet à OPERAT seul."
      ],
      attestation_absente_non_valide: [
        "Confirmer le statut de validation du dossier.",
        "Relire l’écran attestation.",
        "Vérifier si le document est réellement indisponible."
      ],
      attestation_visible_non_telechargee: [
        "Vérifier l’accès au document.",
        "Télécharger puis archiver l’attestation.",
        "Refermer le sujet documentaire."
      ],
      efa_incoherente_multi: [
        "Relire le périmètre EFA.",
        "Contrôler les rattachements.",
        "Vérifier la logique d’occupation."
      ],
      efa_incoherente_mixte: [
        "Revoir la structure du site mixte.",
        "Contrôler le découpage des usages.",
        "Valider le périmètre avant d’aller plus loin."
      ],
      assujettissement_a_confirmer: [
        "Confirmer la surface tertiaire concernée.",
        "Vérifier le seuil et le périmètre réel.",
        "Éviter une lecture réglementaire trop précoce."
      ],
      reference_usage_fragiles: [
        "Revoir l’année de référence.",
        "Contrôler les usages déclarés.",
        "Vérifier la cohérence des éléments explicatifs."
      ],
      donnees_insuffisantes: [
        "Compléter les consommations.",
        "Revoir les surfaces et éléments structurants.",
        "Sécuriser la base avant interprétation."
      ],
      conso_gap_major: [
        "Contrôler la complétude des consommations.",
        "Repérer les trous ou incohérences.",
        "Consolider la base avant toute conclusion."
      ],
      pilotage_ready: [
        "Lire les objectifs en logique de pilotage.",
        "Structurer un plan d’actions.",
        "Transformer la conformité en trajectoire."
      ]
    };

    return map[caseId] || [];
  }

  buildAdaptiveQuestionOrder(userState = {}) {
    const needValue = userState.need;
    const basePool = this.getBaseQuestionPool(needValue);
    const unanswered = basePool.filter((qId) => userState[qId] == null);
    if (!unanswered.length) return [];

    const activeCases = this.getActiveCases(userState);

    if (activeCases.length <= 2) {
      return unanswered.slice(0, this.config.maxQuestionsAfterNeed);
    }

    const scoredQuestions = unanswered.map((questionId) => ({
      questionId,
      score: this.computeQuestionDiscriminationScore(questionId, activeCases)
    }));

    return scoredQuestions
      .sort((a, b) => b.score - a.score)
      .map((x) => x.questionId)
      .slice(0, this.config.maxQuestionsAfterNeed);
  }

  computeQuestionDiscriminationScore(questionId, activeCases) {
    const question = this.getQuestion(questionId);
    if (!question?.options?.length) return 0;

    let score = 0;
    const optionValues = question.options.map((o) => o.value);

    for (const caseDef of activeCases) {
      const conditions = caseDef.conditions || {};
      const allowedValues = conditions[questionId];

      if (!Array.isArray(allowedValues) || !allowedValues.length) {
        score += 0.5;
        continue;
      }

      const coverageRatio = allowedValues.length / optionValues.length;
      if (coverageRatio <= 0.25) score += 3;
      else if (coverageRatio <= 0.5) score += 2;
      else if (coverageRatio <= 0.75) score += 1;
      else score += 0.25;
    }

    return score;
  }

  async runAdaptiveInterview({ botSay, askQuestion, onProgress = () => {}, onDebug = null }) {
    if (typeof botSay !== "function") throw new Error("botSay est requis");
    if (typeof askQuestion !== "function") throw new Error("askQuestion est requis");

    const userState = {};
    const asked = [];

    const needQuestion = this.getEntryNeedQuestion();
    const needValue = await askQuestion(needQuestion, { userState, questionId: "need" });
    userState.need = needValue;
    asked.push("need");
    onProgress(1, 1);

    let guard = 0;
    while (guard < 20) {
      guard += 1;

      const orderedQuestions = this.buildAdaptiveQuestionOrder(userState).filter((qId) => !asked.includes(qId));
      if (!orderedQuestions.length) break;

      const nextQuestionId = orderedQuestions[0];
      const nextQuestion = this.getQuestion(nextQuestionId);
      if (!nextQuestion) break;

      const answer = await askQuestion(nextQuestion, { userState, questionId: nextQuestionId });
      userState[nextQuestionId] = answer;
      asked.push(nextQuestionId);
      onProgress(asked.length, 1 + this.getBaseQuestionPool(userState.need).length);

      if (typeof onDebug === "function") {
        const preview = this.resolveDiagnosis(userState);
        onDebug({ asked: [...asked], userState: { ...userState }, preview });
      }

      const previewDiagnosis = this.resolveDiagnosis(userState);
      if (previewDiagnosis.primary && previewDiagnosis.confidence === "élevée" && asked.length >= 4) {
        break;
      }
    }

    const diagnosis = this.resolveDiagnosis(userState);
    const publicResult = this.buildPublicResult(diagnosis);

    return { userState, diagnosis, publicResult };
  }
}

function createEcoAssistanceChatUI({ messagesEl, optionsEl, progressFill = null, typingDelay = 420 }) {
  if (!messagesEl || !optionsEl) throw new Error("messagesEl et optionsEl sont requis");

  let typingNode = null;
  let isBusy = false;

  function scrollBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function mascotSvg() {
    return `
      <svg viewBox="0 0 64 64" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M16 35c-7 0-11-5-11-11 0-9 8-15 16-15 2-5 7-8 13-8 9 0 16 7 16 16 8 0 14 6 14 14s-6 14-14 14H22c-4 8-9 12-14 14 3-5 5-10 4-15h4Z" fill="#1dcf7a" stroke="#ffffff" stroke-width="2.2"/>
        <ellipse cx="28" cy="27" rx="3.5" ry="6" fill="#ffffff"/>
        <ellipse cx="40" cy="27" rx="3.5" ry="6" fill="#ffffff"/>
        <ellipse cx="28" cy="28" rx="2" ry="3" fill="#0f2218"/>
        <ellipse cx="40" cy="28" rx="2" ry="3" fill="#0f2218"/>
        <path d="M27 39c3 2 7 2 10 0" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`;
  }

  function userSvg() {
    return `
      <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="12" cy="8" r="4" fill="#4aa7dc"/>
        <path d="M4 21c0-3.6 3.7-6 8-6s8 2.4 8 6" fill="#7dd4f8"/>
      </svg>`;
  }

  function addMessage(role, html) {
    const node = document.createElement("div");
    node.className = `msg ${role}`;
    node.innerHTML = `
      <div class="msg-avatar">${role === "bot" ? mascotSvg() : userSvg()}</div>
      <div class="bubble">${html}</div>`;
    messagesEl.appendChild(node);
    scrollBottom();
  }

  function showTyping() {
    hideTyping();
    typingNode = document.createElement("div");
    typingNode.className = "typing-row";
    typingNode.innerHTML = `
      <div class="msg-avatar">${mascotSvg()}</div>
      <div class="typing-bubble" aria-label="La mascotte écrit">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>`;
    messagesEl.appendChild(typingNode);
    scrollBottom();
  }

  function hideTyping() {
    if (typingNode) {
      typingNode.remove();
      typingNode = null;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function botSay(html, delay = typingDelay, signal = null) {
    if (signal?.aborted) throw new DOMException("Abandonné", "AbortError");
    showTyping();
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Abandonné", "AbortError")); }, { once: true });
    });
    if (signal?.aborted) { hideTyping(); throw new DOMException("Abandonné", "AbortError"); }
    hideTyping();
    addMessage("bot", html);
  }

  async function askQuestion(question, signal = null) {
    if (!question?.options?.length) throw new Error("Question invalide");
    if (signal?.aborted) throw new DOMException("Abandonné", "AbortError");

    await botSay(`<strong>${question.label}</strong>`, 380, signal);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Abandonné", "AbortError"));

      optionsEl.innerHTML = "";
      optionsEl.classList.remove("show");

      const onAbort = () => {
        optionsEl.innerHTML = "";
        isBusy = false;
        reject(new DOMException("Abandonné", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      question.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "option-btn";
        btn.textContent = opt.label;

        btn.addEventListener("click", async () => {
          if (isBusy) return;
          isBusy = true;
          signal?.removeEventListener("abort", onAbort);
          optionsEl.innerHTML = "";
          addMessage("user", opt.label);
          resolve(opt.value);
          await wait(120);
          isBusy = false;
        });

        optionsEl.appendChild(btn);
      });

      requestAnimationFrame(() => requestAnimationFrame(() => optionsEl.classList.add("show")));
    });
  }

  function reset() {
    hideTyping();
    isBusy = false;
    messagesEl.innerHTML = "";
    optionsEl.innerHTML = "";
    if (progressFill) progressFill.style.width = "0%";
  }

  function setProgress(current, total) {
    if (!progressFill || !total) return;
    const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    progressFill.style.width = `${pct}%`;
  }

  return { botSay, askQuestion, addMessage, reset, setProgress };
}

window.EcoAssistanceEngine = EcoAssistanceEngine;
window.createEcoAssistanceChatUI = createEcoAssistanceChatUI;
