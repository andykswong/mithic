import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Bash, getCommandNames, type ScriptNode } from 'just-bash';
import { createExecFallbackPlugin } from './transform.ts';
import { RUN_COMMAND_NAME } from './commands.ts';

describe('createExecFallbackPlugin', () => {
  const knownCommands = new Set([...getCommandNames(), RUN_COMMAND_NAME]);
  const plugin = createExecFallbackPlugin({ knownCommands });

  function makeAst(name: string, args: string[] = []): ScriptNode {
    return {
      type: 'Script',
      statements: [{
        type: 'Statement',
        pipelines: [{
          type: 'Pipeline',
          negated: false,
          commands: [{
            type: 'SimpleCommand',
            assignments: [],
            name: { type: 'Word', parts: [{ type: 'Literal', value: name }] },
            args: args.map(a => ({ type: 'Word', parts: [{ type: 'Literal', value: a }] })),
            redirections: [],
          }],
        }],
        operators: [],
        background: false,
      }],
    } as ScriptNode;
  }

  it('rewrites unknown command to run', () => {
    const ast = makeAst('myprogram', ['arg1', 'arg2']);
    const result = plugin.transform({ ast, metadata: {} });

    const cmd = result.ast.statements[0]!.pipelines[0]!.commands[0]!;
    assert.equal(cmd.type, 'SimpleCommand');
    if (cmd.type === 'SimpleCommand') {
      assert.equal(cmd.name!.parts[0]!.type, 'Literal');
      assert.equal((cmd.name!.parts[0] as { value: string }).value, RUN_COMMAND_NAME);
      assert.equal(cmd.args.length, 3);
      assert.equal((cmd.args[0]!.parts[0] as { value: string }).value, 'myprogram');
      assert.equal((cmd.args[1]!.parts[0] as { value: string }).value, 'arg1');
      assert.equal((cmd.args[2]!.parts[0] as { value: string }).value, 'arg2');
    }
    assert.deepEqual(result.metadata, { rewrittenCommands: ['myprogram'] });
  });

  it('does not rewrite known commands', () => {
    const ast = makeAst('echo', ['hello']);
    const result = plugin.transform({ ast, metadata: {} });

    const cmd = result.ast.statements[0]!.pipelines[0]!.commands[0]!;
    assert.equal(cmd.type, 'SimpleCommand');
    if (cmd.type === 'SimpleCommand') {
      assert.equal((cmd.name!.parts[0] as { value: string }).value, 'echo');
      assert.equal(cmd.args.length, 1);
    }
    assert.deepEqual(result.metadata, { rewrittenCommands: [] });
  });

  it('does not rewrite commands with dynamic names', () => {
    const ast: ScriptNode = {
      type: 'Script',
      statements: [{
        type: 'Statement',
        pipelines: [{
          type: 'Pipeline',
          negated: false,
          commands: [{
            type: 'SimpleCommand',
            assignments: [],
            name: { type: 'Word', parts: [
              { type: 'Literal', value: 'prefix' },
              { type: 'ParameterExpansion', parameter: 'CMD', operation: null },
            ] },
            args: [],
            redirections: [],
          }],
        }],
        operators: [],
        background: false,
      }],
    };

    const result = plugin.transform({ ast, metadata: {} });
    const cmd = result.ast.statements[0]!.pipelines[0]!.commands[0]!;
    if (cmd.type === 'SimpleCommand') {
      assert.equal(cmd.name!.parts.length, 2);
      assert.equal((cmd.name!.parts[0] as { value: string }).value, 'prefix');
    }
    assert.deepEqual(result.metadata, { rewrittenCommands: [] });
  });

  it('does not rewrite assignment-only commands (no name)', () => {
    const ast: ScriptNode = {
      type: 'Script',
      statements: [{
        type: 'Statement',
        pipelines: [{
          type: 'Pipeline',
          negated: false,
          commands: [{
            type: 'SimpleCommand',
            assignments: [{ type: 'Assignment', name: 'FOO', value: { type: 'Word', parts: [{ type: 'Literal', value: 'bar' }] } }],
            name: null,
            args: [],
            redirections: [],
          }],
        }],
        operators: [],
        background: false,
      }],
    } as unknown as ScriptNode;

    const result = plugin.transform({ ast, metadata: {} });
    const cmd = result.ast.statements[0]!.pipelines[0]!.commands[0]!;
    if (cmd.type === 'SimpleCommand') {
      assert.equal(cmd.name, null);
    }
    assert.deepEqual(result.metadata, { rewrittenCommands: [] });
  });

  it('rewrites multiple commands in a pipeline', () => {
    const ast: ScriptNode = {
      type: 'Script',
      statements: [{
        type: 'Statement',
        pipelines: [{
          type: 'Pipeline',
          negated: false,
          commands: [
            {
              type: 'SimpleCommand',
              assignments: [],
              name: { type: 'Word', parts: [{ type: 'Literal', value: 'echo' }] },
              args: [{ type: 'Word', parts: [{ type: 'Literal', value: 'hello' }] }],
              redirections: [],
            },
            {
              type: 'SimpleCommand',
              assignments: [],
              name: { type: 'Word', parts: [{ type: 'Literal', value: 'myfilter' }] },
              args: [],
              redirections: [],
            },
          ],
        }],
        operators: [],
        background: false,
      }],
    } as ScriptNode;

    const result = plugin.transform({ ast, metadata: {} });
    const cmds = result.ast.statements[0]!.pipelines[0]!.commands;

    // echo is known — not rewritten
    if (cmds[0]!.type === 'SimpleCommand') {
      assert.equal((cmds[0]!.name!.parts[0] as { value: string }).value, 'echo');
    }
    // myfilter is unknown — rewritten to run
    if (cmds[1]!.type === 'SimpleCommand') {
      assert.equal((cmds[1]!.name!.parts[0] as { value: string }).value, RUN_COMMAND_NAME);
      assert.equal((cmds[1]!.args[0]!.parts[0] as { value: string }).value, 'myfilter');
    }
    assert.deepEqual(result.metadata, { rewrittenCommands: ['myfilter'] });
  });

  it('leaves compound commands untouched', () => {
    const ast: ScriptNode = {
      type: 'Script',
      statements: [{
        type: 'Statement',
        pipelines: [{
          type: 'Pipeline',
          negated: false,
          commands: [{
            type: 'If',
            clauses: [{ condition: [], body: [] }],
            elseBody: null,
            redirections: [],
          }],
        }],
        operators: [],
        background: false,
      }],
    };

    const result = plugin.transform({ ast, metadata: {} });
    const cmd = result.ast.statements[0]!.pipelines[0]!.commands[0]!;
    assert.equal(cmd.type, 'If');
    assert.deepEqual(result.metadata, { rewrittenCommands: [] });
  });

  it('integrates with Bash instance via registerTransformPlugin', () => {
    const bash = new Bash();
    bash.registerTransformPlugin(plugin);

    const result = bash.transform('unknown_cmd arg1');
    assert.ok(result.script.includes(RUN_COMMAND_NAME));
    assert.ok(result.script.includes('unknown_cmd'));
    assert.deepEqual(result.metadata.rewrittenCommands, ['unknown_cmd']);
  });
});
