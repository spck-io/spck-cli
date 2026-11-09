import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpService } from '../AcpService.js';
import type { AuthenticatedSocket } from '../../types.js';

const { request, stop } = vi.hoisted(() => ({ request: vi.fn(), stop: vi.fn() }));
vi.mock('../AcpProcess.js', () => ({
  AcpProcess: class {
    start() {}
    request = request;
    stop = stop;
    onNotification() {}
    onRequest() {}
  },
}));

describe('ACP model discovery and selection', () => {
  let service: AcpService;
  const modelOption = {
    id: 'provider-model', category: 'model', type: 'select', currentValue: 'fast',
    options: [
      { value: 'fast', name: 'Fast', description: 'Quick replies' },
      { value: 'deep', name: 'Deep' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stop.mockResolvedValue(undefined);
    service = new AcpService({
      rootPath: '/project',
      resolveAgents: () => [{ name: 'claude', binary: 'adapter', args: [], version: '1' }],
    });
    request.mockImplementation(async (method: string) => method === 'initialize'
      ? { protocolVersion: 1 }
      : { sessionId: 'session-1', configOptions: [modelOption] });
  });

  it('reads current configOptions model catalogues and their default', async () => {
    expect(await service.capabilities()).toEqual({
      available: true,
      agents: [{ name: 'claude', version: '1', models: [
        { id: 'fast', label: 'Fast', description: 'Quick replies', default: true, agent: 'claude' },
        { id: 'deep', label: 'Deep', agent: 'claude' },
      ] }],
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('flattens grouped models and accepts the conventional model id without a category', async () => {
    request.mockResolvedValueOnce({ protocolVersion: 1 }).mockResolvedValueOnce({
      sessionId: 'session-1', configOptions: [{
        ...modelOption, id: 'model', category: undefined,
        options: [{ group: 'provider', name: 'Provider', options: modelOption.options }],
      }],
    });
    expect((await service.capabilities()).agents[0].models.map((m) => m.id)).toEqual(['fast', 'deep']);
  });

  it.each([
    [{ id: 'legacy', label: 'Legacy', default: true }],
    { currentModelId: 'legacy', availableModels: [{ modelId: 'legacy', name: 'Legacy' }] },
  ])('keeps support for legacy model catalogues (%j)', async (models) => {
    request.mockResolvedValueOnce({ protocolVersion: 1 }).mockResolvedValueOnce({ sessionId: 'old', models });
    expect((await service.capabilities()).agents[0].models).toEqual([
      { id: 'legacy', label: 'Legacy', default: true, agent: 'claude' },
    ]);
  });

  it('applies the selected model through the config option before exposing a session', async () => {
    await service.newSession({ chatId: 'chat', model: 'deep' }, {} as AuthenticatedSocket);
    expect(request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 'session-1', configId: 'provider-model', value: 'deep',
    });
    await service.cleanup();
  });

  it('does not change an already selected model', async () => {
    await service.newSession({ chatId: 'chat', model: 'fast' }, {} as AuthenticatedSocket);
    expect(request.mock.calls.some(([method]) => method === 'session/set_config_option')).toBe(false);
    await service.cleanup();
  });

  it('stops the process if selecting the model fails', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/set_config_option') throw new Error('model rejected');
      return { sessionId: 'session-1', configOptions: [modelOption] };
    });
    await expect(service.newSession({ chatId: 'chat', model: 'deep' }, {} as AuthenticatedSocket))
      .rejects.toThrow('model rejected');
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
