// Fake Anthropic API for tests: records every request body to /tmp/ai-requests.log
// and returns a canned tool call (including deliberately unsafe/weak content
// so the app's filters can be tested).
const http = require('http'); const fs = require('fs');
const LOG = process.env.AI_LOG || '/tmp/ai-requests.log';
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    fs.appendFileSync(LOG, b + '\n');
    const body = JSON.parse(b); const tool = body.tools[0].name;
    // A request mentioning FAIL-AI simulates the AI service being overloaded.
    if (b.includes('FAIL-AI')) { res.statusCode = 529; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); }
    let input;
    if (tool === 'project_draft') input = {
      scope_exclusions: 'In scope:\n- Practice wall to 600 mm\n**Not included:**\n- Permanent walls',
      work_steps: [{ step: 'Set out', hazards: 'Trips', controls: 'Clear area' }, { step: 'Drill holes', hazards: 'Entanglement', controls: 'Pedestal drill used under same-room supervision' }],
      ppe: '- Safety glasses\n- Gloves', induction_supervision: 'Students may use the pedestal drill under general supervision.',
      emergency_considerations: 'Eyewash: [confirm: location]\nFor burns apply ice to the area.', missing_information: ['Confirm first aid person'], assumptions: ['ASSUMPTION: bricks delivered on pallets'],
      cara_suggestions: 'Add brick saw to CARA PERAs.',
    };
    else if (tool === 'cara_draft') input = {
      suggested_risk_level: 'High', risk_reason: 'x',
      emergency_first_aid: '- Raise the alarm and call 000.\n- For severe burns, apply cool water or ice.',
      supervision_notes: 'All equipment other than low-risk hand tools requires direct supervision.\nStudents may use power drills under same-room supervision.',
      environmental_controls: 'Hearing protection when the guillotine and grinder are running.',
    };
    else input = { overall: 'Minor improvements suggested', summary: 'Mock review.', issues: [] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'mock', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: tool, input }] }));
  });
}).listen(4010, () => console.log('mock ai on 4010'));
