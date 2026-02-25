import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
/**
 * Unit tests for ProxySocketWrapper
 */

import { ProxySocketWrapper } from '../ProxySocketWrapper.js';

describe('ProxySocketWrapper', () => {
  let wrapper: ProxySocketWrapper;
  let mockSendFn: Mock;
  const connectionId = 'test-connection-123';
  const userId = 'test-user-456';
  const deviceId = 'test-device-789';

  beforeEach(() => {
    mockSendFn = vi.fn();
    wrapper = new ProxySocketWrapper(connectionId, userId, mockSendFn, deviceId);
  });

  describe('constructor', () => {
    it('should initialize with correct connection ID, user ID, and device ID', () => {
      expect(wrapper.id).toBe(connectionId);
      expect(wrapper.data.uid).toBe(userId);
      expect(wrapper.data.deviceId).toBe(deviceId);
    });

    it('should initialize broadcast object', () => {
      expect(wrapper.broadcast).toBeDefined();
      expect(typeof wrapper.broadcast.emit).toBe('function');
    });
  });

  describe('emit()', () => {
    it('should call sendFn with correct parameters', () => {
      const event = 'test-event';
      const data = { message: 'hello' };

      wrapper.emit(event, data);

      expect(mockSendFn).toHaveBeenCalledWith(connectionId, event, data);
    });

    it('should handle emit without data', () => {
      const event = 'test-event';

      wrapper.emit(event);

      expect(mockSendFn).toHaveBeenCalledWith(connectionId, event, {});
    });

    it('should return true', () => {
      const result = wrapper.emit('test-event');
      expect(result).toBe(true);
    });
  });

  describe('broadcast.emit()', () => {
    it('should call regular emit (sends to single client)', () => {
      const event = 'broadcast-event';
      const data = { type: 'notification' };

      wrapper.broadcast.emit(event, data);

      expect(mockSendFn).toHaveBeenCalledWith(connectionId, event, data);
    });

    it('should return true', () => {
      const result = wrapper.broadcast.emit('test-event');
      expect(result).toBe(true);
    });
  });

  describe('on()', () => {
    it('should register event listener', () => {
      const listener = vi.fn();

      wrapper.on('rpc', listener);

      // Trigger the event
      wrapper.triggerEvent('rpc', { test: 'data' });

      expect(listener).toHaveBeenCalledWith({ test: 'data' });
    });

    it('should support multiple listeners for same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      wrapper.on('rpc', listener1);
      wrapper.on('rpc', listener2);

      wrapper.triggerEvent('rpc', { test: 'data' });

      expect(listener1).toHaveBeenCalledWith({ test: 'data' });
      expect(listener2).toHaveBeenCalledWith({ test: 'data' });
    });

    it('should return this for chaining', () => {
      const listener = vi.fn();
      const result = wrapper.on('test', listener);
      expect(result).toBe(wrapper);
    });
  });

  describe('off()', () => {
    it('should remove specific listener', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      wrapper.on('rpc', listener1);
      wrapper.on('rpc', listener2);
      wrapper.off('rpc', listener1);

      wrapper.triggerEvent('rpc', { test: 'data' });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should remove all listeners for event when no listener specified', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      wrapper.on('rpc', listener1);
      wrapper.on('rpc', listener2);
      wrapper.off('rpc');

      wrapper.triggerEvent('rpc', { test: 'data' });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('should return this for chaining', () => {
      const listener = vi.fn();
      wrapper.on('test', listener);
      const result = wrapper.off('test', listener);
      expect(result).toBe(wrapper);
    });
  });

  describe('once()', () => {
    it('should trigger listener only once', () => {
      const listener = vi.fn();

      wrapper.once('rpc', listener);

      wrapper.triggerEvent('rpc', { call: 1 });
      wrapper.triggerEvent('rpc', { call: 2 });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ call: 1 });
    });

    it('should return this for chaining', () => {
      const listener = vi.fn();
      const result = wrapper.once('test', listener);
      expect(result).toBe(wrapper);
    });
  });

  describe('removeAllListeners()', () => {
    it('should remove all listeners for specific event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      wrapper.on('event1', listener1);
      wrapper.on('event2', listener2);

      wrapper.removeAllListeners('event1');

      wrapper.triggerEvent('event1', {});
      wrapper.triggerEvent('event2', {});

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should remove all listeners when no event specified', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      wrapper.on('event1', listener1);
      wrapper.on('event2', listener2);

      wrapper.removeAllListeners();

      wrapper.triggerEvent('event1', {});
      wrapper.triggerEvent('event2', {});

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('should return this for chaining', () => {
      const result = wrapper.removeAllListeners();
      expect(result).toBe(wrapper);
    });
  });

  describe('triggerEvent()', () => {
    it('should call all registered listeners with arguments', () => {
      const listener = vi.fn();

      wrapper.on('test', listener);
      wrapper.triggerEvent('test', 'arg1', 'arg2', 'arg3');

      expect(listener).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
    });

    it('should handle errors in listeners gracefully', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation();

      wrapper.on('test', errorListener);
      wrapper.on('test', goodListener);

      wrapper.triggerEvent('test', {});

      expect(errorListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should do nothing if no listeners registered', () => {
      // Should not throw
      expect(() => {
        wrapper.triggerEvent('nonexistent-event', {});
      }).not.toThrow();
    });
  });

  describe('id getter', () => {
    it('should return connection ID', () => {
      expect(wrapper.id).toBe(connectionId);
    });
  });

  describe('data property', () => {
    it('should have uid property', () => {
      expect(wrapper.data).toHaveProperty('uid');
      expect(wrapper.data.uid).toBe(userId);
    });
  });
});
