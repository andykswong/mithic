/** A console-like UI. */
export function createConsole() {
  const output = document.createElement('pre');
  document.body.appendChild(output);

  const input = document.createElement('input');
  input.style.display = 'inline-block';
  input.style.border = 'none';
  input.style.outline = 'none';
  output.appendChild(input);
  input.focus();

  const console = {
    input,
    output,
    appendText(text) {
      output.insertBefore(document.createTextNode(text), input);
      input.focus();
    },
    onInput: undefined,
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') { return; }
    const val = input.value + '\n';
    input.value = '';
    console.appendText(val);
    console.onInput?.(val);
  });

  return console;
}
