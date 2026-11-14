function formatPerformance(profile) {
  if (!profile) return [];
  const lines = [];
  if (profile.longevity?.status === "estimated") {
    lines.push("Duración estimada: " + profile.longevity.display + ".");
  }
  if (profile.projectionDuration?.status === "estimated") {
    lines.push("Proyección perceptible estimada: " + profile.projectionDuration.display + ".");
  }
  if (profile.intensity?.status === "estimated") {
    lines.push("Intensidad registrada: " + profile.intensity.label + ".");
  }
  if (profile.projection?.status === "estimated") {
    lines.push("Proyección registrada: " + profile.projection.label + ".");
  }
  return lines;
}

/**
 * Builds a customer-facing explanation using only matched catalog fields and
 * performance claims already admitted by the evidence policy.
 */
export function buildFragranceCustomerExplanation({ preferenceMatch, performance = [] } = {}) {
  if (!preferenceMatch || !Array.isArray(preferenceMatch.ranking)) {
    return Object.freeze({
      decision: "needs_clarification",
      text: "Necesito conocer un poco más sobre el aroma, la ocasión o la intensidad que buscas para recomendarte con fundamento.",
      reasons: Object.freeze([]),
      performance: Object.freeze([]),
      disclaimer: "No se ha seleccionado un perfume.",
    });
  }
  if (preferenceMatch.decision === "tie") {
    return Object.freeze({
      decision: "tie",
      text: "Hay dos o más perfumes con una compatibilidad similar con tus preferencias. Prefiero mostrarte las alternativas y explicarte sus diferencias antes que elegir uno sin una ventaja clara.",
      reasons: Object.freeze([]),
      performance: Object.freeze([]),
      disclaimer: "No se ha seleccionado un ganador único.",
    });
  }
  const winner = preferenceMatch.ranking.find(item => item.eligibility === "eligible");
  if (!winner) {
    return Object.freeze({
      decision: "no_eligible_match",
      text: "Con la información disponible no puedo justificar una recomendación fiable. Prefiero preguntarte un poco más antes que sugerirte un perfume sin suficiente coincidencia.",
      reasons: Object.freeze([]),
      performance: Object.freeze([]),
      disclaimer: "No se ha seleccionado un perfume porque faltan coincidencias o datos suficientes.",
    });
  }

  const reasons = winner.explanation?.reasons ?? [];
  const performanceProfile = performance.find(item => item.productId === winner.id);
  const performanceLines = formatPerformance(performanceProfile);
  const opening = "Te recomiendo considerar " + winner.name + " porque coincide con tus preferencias.";
  const reasonText = reasons.length
    ? " " + reasons.join(" ")
    : " La información disponible muestra una coincidencia general, pero no hay suficientes detalles para explicar criterios concretos.";
  const performanceText = performanceLines.length
    ? " " + performanceLines.join(" ")
    : " No tengo un rango de rendimiento respaldado por evidencia suficiente para comunicarte su duración o proyección.";
  const disclaimer = "Son estimaciones y características documentadas, no garantías. El rendimiento puede variar según la piel, la aplicación, la temperatura y la humedad.";
  return Object.freeze({
    decision: "recommended",
    productId: winner.id,
    productName: winner.name,
    matchScore: winner.score,
    matchCoverage: winner.coverage,
    text: opening + reasonText + performanceText + " " + disclaimer,
    reasons: Object.freeze([...reasons]),
    performance: Object.freeze(performanceLines),
    disclaimer,
  });
}
