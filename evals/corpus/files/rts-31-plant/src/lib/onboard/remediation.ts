// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function printRemediationActions(
  actions:
    | readonly {
        id: string;
        title: string;
        reason: string;
        commands?: readonly string[];
      }[]
    | null
    | undefined,
): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  console.error("");
  console.error("  Suggested fix:");
  console.error("");
  for (const action of actions) {
    console.error(`  - ${action.title} (${action.id}): ${action.reason}`);
    for (const command of action.commands || []) {
      console.error(`    ${command}`);
    }
  }
}

export function getFutureShellPathHint(
  binDir: string,
  pathValue = process.env.PATH || "",
): string | null {
  const parts = String(pathValue).split(path.delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "nemotron-super": { input: 0.4, output: 1.2 },
  "nemotron-nano": { input: 0.1, output: 0.3 },
};

export function estimateInferenceCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICE_PER_MILLION_TOKENS[model];
  if (!price) {
    throw new Error(`No pricing configured for model: ${model}`);
  }
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}