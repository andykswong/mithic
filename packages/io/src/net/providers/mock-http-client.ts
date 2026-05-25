import type { HttpClient, HttpRequest, HttpResponse } from '../http.ts';

/** HTTP client that returns preconfigured responses (for testing). */
export class MockHttpClient implements HttpClient {
  private responses: Map<string, HttpResponse> = new Map();

  /** Register a mock response for a URL pattern. */
  addResponse(urlPattern: string, response: HttpResponse): void {
    this.responses.set(urlPattern, response);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    // Try exact match first, then prefix match
    const response = this.responses.get(request.url);
    if (response) {
      return response;
    }

    // Try prefix matching
    for (const [pattern, resp] of this.responses) {
      if (request.url.startsWith(pattern)) {
        return resp;
      }
    }

    throw new Error(`No mock response configured for: ${request.url}`);
  }
}
