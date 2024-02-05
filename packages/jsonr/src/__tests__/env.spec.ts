import { describe, expect, it } from '@jest/globals';
import { ProtoChainEnv } from '../env.ts';

describe(ProtoChainEnv, () => {
  describe('constructor', () => {
    it('should have the correct binding chain', () => {
      const global = new ProtoChainEnv();
      const parent = new ProtoChainEnv(global);
      const child = new ProtoChainEnv(parent);

      expect(Object.getPrototypeOf(global['binds'])).toBe(null);
      expect(Object.getPrototypeOf(parent['binds'])).toBe(global['binds']);
      expect(Object.getPrototypeOf(child['binds'])).toBe(parent['binds']);
    });
  });

  describe('global', () => {
    it('should carry global scope from parent', () => {
      const global = new ProtoChainEnv();
      const parent = new ProtoChainEnv(global);
      const child = new ProtoChainEnv(parent);

      expect(global.global).toBe(global);
      expect(parent.global).toBe(global);
      expect(child.global).toBe(global);
    });
  });

  describe('async', () => {
    it('should be true for global scope', () => {
      const global = new ProtoChainEnv();
      expect(global.async).toBe(true);
    });

    it('should be false by default', () => {
      const global = new ProtoChainEnv();
      const env = new ProtoChainEnv(global);
      expect(env.async).toBe(false);
    });

    it('should return previously set value on current scope', () => {
      const global = new ProtoChainEnv();
      const parent = new ProtoChainEnv(global);
      const child = new ProtoChainEnv(parent);
      parent.async = true;
      child.async = false;
      expect(child.async).toBe(false);
      parent.async = false;
      child.async = true;
      expect(child.async).toBe(true);
    });
  });

  describe('get', () => {
    it('should return values from env stack', () => {
      const global = new ProtoChainEnv(null, { scope: 'global', global: true });
      const child = new ProtoChainEnv(global, { scope: 'child' });

      expect(child.get('scope')).toBe('child');
      expect(child.get('global')).toBe(true);
    });

    it('should return undefined for non-existent keys', () => {
      const global = new ProtoChainEnv(null, { scope: 'global', global: true });
      const child = new ProtoChainEnv(global, { scope: 'child' });

      expect(child.get('abc')).toBeUndefined();
    });
  });

  describe('getOwn', () => {
    it('should return values from own scope', () => {
      const global = new ProtoChainEnv(null, { scope: 'global', global: true });
      const child = new ProtoChainEnv(global, { scope: 'child' });

      expect(child.getOwn('scope')).toBe('child');
    });

    it('should return undefined for keys not in own scope', () => {
      const global = new ProtoChainEnv(null, { scope: 'global', global: true });
      const child = new ProtoChainEnv(global, { scope: 'child' });

      expect(child.getOwn('global')).toBeUndefined();
      expect(child.getOwn('abc')).toBeUndefined();
    });
  });

  describe('set', () => {
    it('should set value to correct scope', () => {
      const global = new ProtoChainEnv(null);
      const child = new ProtoChainEnv(global);
      global.set('scope', 'global');
      child.set('scope', 'child');
      child.set('child', true);

      expect(child.get('scope')).toBe('child');
      expect(child.get('child')).toBe(true);
      expect(global.get('scope')).toBe('child');
      expect(global.get('child')).toBeUndefined();
    });
  });

  describe('setOwn', () => {
    it('should set value to current scope', () => {
      const global = new ProtoChainEnv(null);
      const child = new ProtoChainEnv(global);
      global.set('scope', 'global');
      child.setOwn('scope', 'child');

      expect(child.get('scope')).toBe('child');
      expect(global.get('scope')).toBe('global');
    });

    it('should set non writable value if readOnly = true', () => {
      const env = new ProtoChainEnv();
      env.setOwn('field', 'value', true);
      expect(() => env.set('field', 'value2')).toThrow(/Cannot assign/);
    });
  });

  describe('push', () => {
    it('should return a child scope', () => {
      const env = new ProtoChainEnv();
      const child = env.push();

      expect(child.global).toBe(env);
      expect(Object.getPrototypeOf(child['binds'])).toBe(env['binds']);
    });
  });
});
