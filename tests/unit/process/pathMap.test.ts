import { describe, expect, it } from 'vitest';
import { CONTAINER_WORKSPACE, isContainerPath, toContainerPath, toRendererPath } from '@process/runtime/pathMap';

describe('toContainerPath', () => {
  it('maps relative paths onto /workspace', () => {
    expect(toContainerPath('src/app.ts')).toBe('/workspace/src/app.ts');
    expect(toContainerPath('./src/app.ts')).toBe('/workspace/src/app.ts');
  });

  it('returns /workspace for empty / dot inputs', () => {
    expect(toContainerPath('')).toBe(CONTAINER_WORKSPACE);
    expect(toContainerPath('.')).toBe(CONTAINER_WORKSPACE);
    expect(toContainerPath('  ')).toBe(CONTAINER_WORKSPACE);
  });

  it('refuses absolute host paths outside the workspace', () => {
    expect(toContainerPath('/etc/passwd')).toBeNull();
    expect(toContainerPath('/Users/alice/secret.txt')).toBeNull();
    expect(toContainerPath('C:\\Users\\alice\\secret.txt')).toBeNull();
  });

  it('rejects paths that try to escape via ..', () => {
    expect(toContainerPath('../etc/passwd')).toBeNull();
    expect(toContainerPath('foo/../../etc/passwd')).toBeNull();
    expect(toContainerPath('foo/bar/../../..')).toBeNull();
  });

  it('collapses inner . and .. segments that stay inside the workspace', () => {
    expect(toContainerPath('src/./util/../app.ts')).toBe('/workspace/src/app.ts');
  });

  it('accepts paths already prefixed with /workspace', () => {
    expect(toContainerPath('/workspace/src/app.ts')).toBe('/workspace/src/app.ts');
    expect(toContainerPath('/workspace')).toBe(CONTAINER_WORKSPACE);
  });

  it('rejects a /workspace prefix that tries to escape', () => {
    expect(toContainerPath('/workspace/../etc/passwd')).toBeNull();
  });
});

describe('toRendererPath', () => {
  it('strips the /workspace prefix and returns a relative path', () => {
    expect(toRendererPath('/workspace/src/app.ts')).toBe('src/app.ts');
  });

  it('returns an empty string for the workspace root itself', () => {
    expect(toRendererPath('/workspace')).toBe('');
  });

  it('returns null for paths outside the workspace', () => {
    expect(toRendererPath('/etc/passwd')).toBeNull();
    expect(toRendererPath('/var/lib/aionui/data')).toBeNull();
  });

  it('handles backslash separators by normalising to forward slashes', () => {
    expect(toRendererPath('/workspace\\src\\app.ts')).toBe('src/app.ts');
  });
});

describe('isContainerPath', () => {
  it('returns true only for absolute paths under /workspace', () => {
    expect(isContainerPath('/workspace')).toBe(true);
    expect(isContainerPath('/workspace/file.txt')).toBe(true);
    expect(isContainerPath('/workspaceee')).toBe(false);
    expect(isContainerPath('/etc/passwd')).toBe(false);
    expect(isContainerPath('src/app.ts')).toBe(false);
  });
});
