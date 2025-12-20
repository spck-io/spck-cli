/**
 * ProxySocketWrapper - Emulates AuthenticatedSocket for proxy mode
 * Routes socket.emit() calls through ProxyClient.sendToClient()
 */

/**
 * Lightweight socket wrapper for proxy mode
 * Provides the minimal interface needed by services (duck typing)
 */
export class ProxySocketWrapper {
  public data: { uid: string };
  public broadcast: { emit: (event: string, data?: any) => boolean };
  private eventListeners: Map<string, Set<(...args: any[]) => void>> = new Map();

  constructor(
    private connectionId: string,
    private userId: string,
    private sendFn: (connectionId: string, data: any) => void
  ) {
    // Set up data property to match AuthenticatedSocket
    this.data = { uid: userId };

    // Set up broadcast - in proxy mode, just send to the single connected client
    this.broadcast = {
      emit: (event: string, data?: any) => {
        return this.emit(event, data);
      }
    };
  }

  /**
   * Emit event to client via proxy
   * This is the main method used by services to send data back to clients
   */
  emit(event: string, data?: any): boolean {
    // Send through proxy client
    this.sendFn(this.connectionId, {
      event,
      data: data || {}
    });

    return true; // Return true to match socket.io API
  }

  /**
   * Get connection ID
   */
  get id(): string {
    return this.connectionId;
  }

  /**
   * Event handling methods
   * These store listeners that are triggered when messages arrive from the client
   */

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const onceWrapper = (...args: any[]) => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    return this.on(event, onceWrapper);
  }

  off(event: string, listener?: (...args: any[]) => void): this {
    if (!listener) {
      // Remove all listeners for this event
      this.eventListeners.delete(event);
      return this;
    }

    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(event);
      }
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.eventListeners.delete(event);
    } else {
      this.eventListeners.clear();
    }
    return this;
  }

  /**
   * Trigger event listeners (called by ProxyClient when messages arrive)
   */
  triggerEvent(event: string, ...args: any[]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          console.error(`Error in event listener for '${event}':`, error);
        }
      });
    }
  }
}
