/** Synthetic response shapes from the supplied research; no captured live responses. */
export const synthetic = {
  openai: {
    id: 'synthetic-openai',
    status: 'completed',
    output: [
      { type: 'web_search_call' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'HubSpot is an option.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://www.hubspot.com/',
                title: 'HubSpot',
                start_index: 0,
                end_index: 7,
              },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
  perplexity: {
    id: 'synthetic-perplexity',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Pipedrive is an option.' }],
      },
      {
        type: 'search_results',
        results: [
          { id: '1', url: 'https://pipedrive.com/', title: 'Pipedrive' },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cost: { total_cost: 0.003 },
    },
  },
  gemini: {
    responseId: 'synthetic-gemini',
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: 'Attio is an option.' }] },
        groundingMetadata: {
          webSearchQueries: ['CRM'],
          groundingChunks: [
            {
              web: {
                uri: 'https://vertexaisearch.cloud.google.com/redirect',
                title: 'attio.com',
              },
            },
          ],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: 5 },
              groundingChunkIndices: [0],
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  },
  anthropic: {
    id: 'synthetic-anthropic',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: 'Close is an option.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://close.com/',
            title: 'Close',
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      server_tool_use: { web_search_requests: 1 },
    },
  },
};
