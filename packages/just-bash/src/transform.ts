import type {
  TransformPlugin, TransformContext, TransformResult,
  ScriptNode, StatementNode, PipelineNode, CommandNode, SimpleCommandNode, WordNode,
} from 'just-bash';
import { RUN_COMMAND_NAME } from './commands.ts';

export interface ExecFallbackMetadata {
  rewrittenCommands: string[];
}

export interface ExecFallbackPluginOptions {
  knownCommands: Set<string>;
}

export function createExecFallbackPlugin(options: ExecFallbackPluginOptions): TransformPlugin<ExecFallbackMetadata> {
  const { knownCommands } = options;

  return {
    name: 'exec-fallback',
    transform(context: TransformContext): TransformResult<ExecFallbackMetadata> {
      const rewritten: string[] = [];
      const ast = walkScript(context.ast, rewritten);
      return { ast, metadata: { rewrittenCommands: rewritten } };
    },
  };

  function walkScript(script: ScriptNode, rewritten: string[]): ScriptNode {
    return {
      ...script,
      statements: script.statements.map(s => walkStatement(s, rewritten)),
    };
  }

  function walkStatement(stmt: StatementNode, rewritten: string[]): StatementNode {
    return {
      ...stmt,
      pipelines: stmt.pipelines.map(p => walkPipeline(p, rewritten)),
    };
  }

  function walkPipeline(pipeline: PipelineNode, rewritten: string[]): PipelineNode {
    return {
      ...pipeline,
      commands: pipeline.commands.map(c => walkCommand(c, rewritten)),
    };
  }

  function walkCommand(cmd: CommandNode, rewritten: string[]): CommandNode {
    if (cmd.type !== 'SimpleCommand') return cmd;
    return rewriteSimpleCommand(cmd, rewritten);
  }

  function rewriteSimpleCommand(cmd: SimpleCommandNode, rewritten: string[]): SimpleCommandNode {
    if (!cmd.name) return cmd;

    const name = getStaticLiteral(cmd.name);
    if (name === undefined) return cmd;
    if (knownCommands.has(name)) return cmd;

    rewritten.push(name);
    return {
      ...cmd,
      name: { type: 'Word', parts: [{ type: 'Literal', value: RUN_COMMAND_NAME }] } as WordNode,
      args: [cmd.name, ...cmd.args],
    };
  }

  function getStaticLiteral(word: WordNode): string | undefined {
    if (word.parts.length === 1 && word.parts[0]!.type === 'Literal') {
      return word.parts[0]!.value;
    }
    return undefined;
  }
}
