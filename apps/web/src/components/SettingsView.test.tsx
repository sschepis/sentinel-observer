import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import type { LearningEngine } from '../learning/useLearningEngine';
import { DEFAULT_MODEL_SETTINGS, type ModelSettings } from '../observer/modelSettings';
import { MemoryPersistenceStore } from '../persistence/store';

function engineStub(overrides: Partial<LearningEngine> = {}): LearningEngine {
  return {
    settings: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' },
    saveSettings: () => {},
    configured: false,
    model: { ...DEFAULT_MODEL_SETTINGS },
    saveModel: () => {},
    events: [],
    clearEvents: () => {},
    pushEvent: () => {},
    running: false,
    stats: {
      cycles: 0,
      wordsTaught: 0,
      wordsReviewed: 0,
      phrasesTaught: 0,
      llmCalls: 0,
      selfAnswered: 0,
      creativeScores: [],
      drillsRun: 0,
      drillsInduced: 0,
      drillsMemorized: 0,
      lastDrill: null
    },
    error: null,
    start: () => {},
    stop: () => {},
    definitionProgress: null,
    definitionResult: null,
    runDefinitions: () => {},
    cancelDefinitions: () => {},
    revision: 0,
    ...overrides
  };
}

const store = new MemoryPersistenceStore();

function renderSettings(engine: LearningEngine) {
  return render(
    <SettingsView
      teacher={null}
      engine={engine}
      persistenceKind="memory"
      restoredCount={0}
      staleCount={0}
      onRecordImported={() => {}}
    />
  );
}

describe('SettingsView model controls', () => {
  it('states the forgetting half-lives in days rather than a bare number', () => {
    renderSettings(engineStub());
    expect(screen.getByText(/half its strength after 7 days unpractised/)).toBeDefined();
  });

  it('restates the half-lives when the rate changes', () => {
    renderSettings(engineStub({ model: { ...DEFAULT_MODEL_SETTINGS, forgettingRate: 2 } }));
    expect(screen.getByText(/after 14 days unpractised, 60 once practised, 240 once consolidated/)).toBeDefined();
    expect(screen.getByText('2× slower')).toBeDefined();
  });

  it('describes a rate below one as faster forgetting', () => {
    renderSettings(engineStub({ model: { ...DEFAULT_MODEL_SETTINGS, forgettingRate: 0.5 } }));
    expect(screen.getByText('2× faster')).toBeDefined();
  });

  it('saves a new forgetting rate', () => {
    const saved: ModelSettings[] = [];
    renderSettings(engineStub({ saveModel: (next) => saved.push(next) }));
    fireEvent.change(screen.getByLabelText('Forgetting'), { target: { value: '3' } });
    expect(saved[0]?.forgettingRate).toBe(3);
  });

  it('exposes the pacing controls', () => {
    const saved: ModelSettings[] = [];
    renderSettings(engineStub({ saveModel: (next) => saved.push(next) }));
    fireEvent.change(screen.getByLabelText('New words per cycle'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Reviews per cycle'), { target: { value: '5' } });
    expect(saved[0]?.wordsPerCycle).toBe(8);
    expect(saved[1]?.reviewsPerCycle).toBe(5);
  });

  it('resets to defaults', () => {
    const saveModel = jest.fn();
    renderSettings(engineStub({ model: { ...DEFAULT_MODEL_SETTINGS, forgettingRate: 4 }, saveModel }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(saveModel).toHaveBeenCalledWith(DEFAULT_MODEL_SETTINGS);
  });

  it('says plainly which settings are not adjustable and why', () => {
    renderSettings(engineStub());
    expect(screen.getByText(/prime basis and vocabulary are deliberately not adjustable/)).toBeDefined();
  });
});

describe('SettingsView provider status', () => {
  it('reports an unconfigured provider honestly', () => {
    renderSettings(engineStub({ configured: false }));
    expect(screen.getByText(/not configured/)).toBeDefined();
  });

  it('reports a configured provider', () => {
    renderSettings(engineStub({ configured: true }));
    expect(screen.getByText(/configured — up to/)).toBeDefined();
  });

  it('reports session-only storage without pretending it persists', () => {
    renderSettings(engineStub());
    expect(screen.getByText(/Session-only: no persistent storage available/)).toBeDefined();
    expect(store.kind).toBe('memory');
  });
});
