import type { AppConfig } from '../config/config';
import type { MlClient } from './client';
import { shouldKeepOneModel, UnavailableStt, WebLlm, WebStt } from './engines';
import { FakeLlm, FakeStt } from './fakes';
import { FallbackLlm } from './fallbackLlm';
import { LlmTasks, type TaskLimits } from './llmTasks';
import { findModel, STT_MODELS } from './models';
import type { DownloadedModels } from './models.state';
import { PromptSet } from './prompts';
import type { EngineKind, Llm, Stt } from './types';

export interface MlServices {
  llm: Llm;
  tasks: LlmTasks;
  stt: Stt;
  llmKind: EngineKind;
  /** `unavailable`: no speech model on the phone, so voice notes wait for one. */
  sttKind: EngineKind | 'unavailable';
  /** Starts loading the on-device models in the background so the first call is fast. */
  warmUp(): void;
}

export interface MlDeps {
  config: AppConfig;
  /** Null when the model worker can't run (e.g. tests, very old browsers): only fakes and fallbacks are possible. */
  client: MlClient | null;
  downloaded: DownloadedModels;
  fallback: FallbackLlm;
  prompts?: PromptSet;
  limits?: Partial<TaskLimits>;
  onDegraded?: (task: string, reason: unknown) => void;
  /** Overrides the memory check (tests). */
  keepOneModel?: boolean;
}

/**
 * Builds the language and speech engines from the settings:
 * - llm auto:      on-device if that model was downloaded, else pre-written text and rule-based cleanup
 * - llm device:    on-device only (LlmTasks still falls back for text it can't get)
 * - llm fallback:  pre-written text and rule-based cleanup
 * - llm fake:      deterministic fakes
 * - stt auto/device: on-device if downloaded, else notes are kept and wait for the model
 * - stt fake:      canned transcript (desk testing only; never chosen automatically)
 */
export function createMlServices(d: MlDeps): MlServices {
  const { config, client, downloaded, fallback } = d;
  const exclusive = d.keepOneModel ?? shouldKeepOneModel();
  const llmReady = !!findModel('llm', config.ml.llmModel) && downloaded.has('llm', config.ml.llmModel);
  const sttReady = !!findModel('stt', config.ml.sttModel) && downloaded.has('stt', config.ml.sttModel);

  let llm: Llm;
  let llmKind: EngineKind;
  const useDeviceLlm = client && (config.llmMode === 'device' || (config.llmMode === 'auto' && llmReady));
  if (config.llmMode === 'fake') {
    llm = new FakeLlm();
    llmKind = 'fake';
  } else if (useDeviceLlm) {
    llm = new WebLlm(client, config.ml, exclusive);
    llmKind = 'device';
  } else {
    llm = fallback;
    llmKind = 'fallback';
  }

  let stt: Stt;
  let sttKind: MlServices['sttKind'];
  const useDeviceStt = client && (config.sttMode === 'device' || (config.sttMode === 'auto' && sttReady));
  if (config.sttMode === 'fake') {
    stt = new FakeStt();
    sttKind = 'fake';
  } else if (useDeviceStt) {
    const alternates = STT_MODELS.filter((m) => m.id !== config.ml.sttModel && downloaded.has('stt', m.id)).map((m) => m.id);
    stt = new WebStt(client, config.ml, exclusive, alternates);
    sttKind = 'device';
  } else {
    stt = new UnavailableStt();
    sttKind = 'unavailable';
  }

  const tasks = new LlmTasks(llm, {
    backup: llm === fallback ? null : fallback,
    timeoutMs: config.ml.llmTimeoutMs,
    prompts: d.prompts ?? new PromptSet(),
    limits: d.limits,
    onDegraded: d.onDegraded ?? ((task, reason) => console.warn(`[ml] ${task} degraded:`, reason)),
  });

  return {
    llm, tasks, stt, llmKind, sttKind,
    warmUp() {
      if (llm instanceof WebLlm) void llm.warmUp();
      if (stt instanceof WebStt) void stt.warmUp();
    },
  };
}
