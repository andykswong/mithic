/** Wait for a certain amount of time in millseconds. This wraps `setTimeout` as a Promise. */
export function wait(timeMs = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeMs));
}
