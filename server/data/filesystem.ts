import { readFile, writeFile, mkdir } from 'fs/promises';
import { watch } from 'fs';
import { join } from 'path';
import type { PipelineStage, PipelineStatus, PipelineCheckpoint } from '../shared/types.js';

export class LocalFileSystem {
  constructor(private projectDir: string) {}

  getRunDir(sessionId: string): string {
    return join(this.projectDir, `run-${sessionId}`);
  }

  async readStageOutput(sessionId: string, stage: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await readFile(join(this.getRunDir(sessionId), `${stage}.json`), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async writeStageOutput(sessionId: string, stage: string, data: Record<string, unknown>): Promise<void> {
    const runDir = this.getRunDir(sessionId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, `${stage}.json`), JSON.stringify(data, null, 2), 'utf-8');
  }

  async readCheckpoint(sessionId: string): Promise<PipelineCheckpoint | null> {
    try {
      const content = await readFile(join(this.getRunDir(sessionId), 'checkpoint.json'), 'utf-8');
      const parsed = JSON.parse(content) as PipelineCheckpoint;
      if (parsed.version !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async writeCheckpoint(checkpoint: PipelineCheckpoint): Promise<void> {
    const runDir = this.getRunDir(checkpoint.session_id);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  async readStatusFile(sessionId: string): Promise<string | null> {
    try {
      return await readFile(join(this.getRunDir(sessionId), 'status.yaml'), 'utf-8');
    } catch {
      return null;
    }
  }

  async writeStatusFile(sessionId: string, content: string): Promise<void> {
    const runDir = this.getRunDir(sessionId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'status.yaml'), content, 'utf-8');
  }

  async watchPipeline(
    sessionId: string,
    onStageComplete: (stage: string, data: Record<string, unknown>) => void
  ): Promise<() => void> {
    const runDir = this.getRunDir(sessionId);
    await mkdir(runDir, { recursive: true });

    let watcher: ReturnType<typeof watch> | null = null;
    let pollingTimer: ReturnType<typeof setInterval> | null = null;
    const knownFiles = new Set<string>();

    const debounceMs = 5000;
    const lastHandledTimes = new Map<string, number>();

    const handleFile = async (filename: string | null) => {
      if (!filename || !filename.endsWith('.json') || filename === 'checkpoint.json') return;
      const stage = filename.replace('.json', '');
      const now = Date.now();
      const last = lastHandledTimes.get(stage) || 0;
      if (now - last < debounceMs) return;
      lastHandledTimes.set(stage, now);
      try {
        const data = await this.readStageOutput(sessionId, stage);
        if (data) {
          onStageComplete(stage, data);
        }
      } catch {
        // ignore parse/read errors
      }
    };

    // Scan existing files on startup (important for resume/reconnect)
    try {
      const { readdir } = await import('fs/promises');
      const entries = await readdir(runDir);
      for (const name of entries) {
        if (name.endsWith('.json') && name !== 'checkpoint.json') {
          knownFiles.add(name);
          await handleFile(name);
        }
      }
    } catch {
      // ignore
    }

    try {
      watcher = watch(runDir, (eventType, filename) => {
        if (eventType === 'change' || eventType === 'rename') {
          handleFile(filename);
        }
      });
    } catch {
      // Fallback to polling if fs.watch fails
    }

    // Polling fallback / supplement: scan every 2 seconds
    pollingTimer = setInterval(async () => {
      try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(runDir);
        for (const name of entries) {
          if (name.endsWith('.json') && name !== 'checkpoint.json' && !knownFiles.has(name)) {
            knownFiles.add(name);
            await handleFile(name);
          }
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
    };
  }
}
