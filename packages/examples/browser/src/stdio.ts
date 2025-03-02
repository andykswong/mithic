
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** creates a stdin stream. */
export function stdin(setCallback: (onInput: (value: string) => void) => void) {
  return new ReadableStream({
    start(controller) {
      setCallback((val) => controller.enqueue(encoder.encode(val)));
    }
  });
}

/** creates a stdout stream. */
export function stdout(write: (output: string) => void) {
  let lastWrite = 0;
  return new WritableStream({
    write(chunk) {
      const writeTime = lastWrite = Date.now();
      const content = decoder.decode(chunk, { stream: true });
      setTimeout(() => writeTime === lastWrite && write(content), 100);
    }
  });
}
