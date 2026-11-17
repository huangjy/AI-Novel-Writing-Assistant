const test = require('node:test');
const assert = require('node:assert/strict');
const { getRegisteredPromptAsset } = require('../dist/prompting/registry');
const { z } = require('zod');
const { outlineImportParsePrompt } = require('../dist/prompting/prompts/outline/outline.prompts');

test('outline prompts are registered with structured schemas and isolated context policy', () => {
  for (const [id, version] of [
    ['outline.initial_generate', 'v1'],
    ['outline.edit_proposal', 'v2'],
    ['outline.import_parse', 'v2'],
  ]) {
    const asset = getRegisteredPromptAsset(id, version);
    assert.ok(asset, `${id}@${version} must be available by its exact registered version`);
    assert.equal(asset.mode, 'structured');
    assert.ok(asset.outputSchema);
    assert.equal(asset.contextPolicy.maxTokensBudget, 8000);
  }
});

test('outline import uses required nullable parent references for strict JSON output', () => {
  const schema = z.toJSONSchema(outlineImportParsePrompt.outputSchema, { unrepresentable: 'any' });
  const node = schema.properties.nodes.items;
  assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
  assert.ok(node.properties.parentRef.anyOf.some(branch => branch.type === 'null'));
  const volume = {
    clientRef: 'v1', title: '第一卷', summary: '启程', planningDepth: 'rough',
    reason: '原文明确给出卷标题', sourceFragment: '第一卷', nodeType: 'volume', parentRef: null,
  };
  const output = { nodes: [volume], unclassifiedFragments: [], coverageNotes: [] };
  assert.equal(outlineImportParsePrompt.outputSchema.safeParse(output).success, true);
  const { parentRef, ...withoutParentRef } = volume;
  assert.equal(outlineImportParsePrompt.outputSchema.safeParse({ ...output, nodes: [withoutParentRef] }).success, false);
  assert.equal(outlineImportParsePrompt.outputSchema.safeParse({ ...output, nodes: [{ ...volume, parentRef: 123 }] }).success, false);
});

test('outline.edit_proposal schema rejects node-id dependsOn, missing volumeNodeId and chapterNodeIds shortcut', () => {
  const asset = getRegisteredPromptAsset('outline.edit_proposal', 'v2');
  const schema = asset.outputSchema;

  assert.equal(schema.safeParse({
    operations: [{
      operationId: 'op-1', kind: 'add_node', nodeType: 'chapter', clientRef: 'c1',
      fields: { title: '章', summary: 's', volumeNodeId: 'vol-1' },
      reason: 'r', affectedNodeIds: [], dependsOn: ['vol-1'], risks: [],
    }],
  }).success, false);

  assert.equal(schema.safeParse({
    operations: [{
      operationId: 'op-1', kind: 'add_node', nodeType: 'chapter', clientRef: 'c1',
      fields: { title: '章', summary: 's' },
      reason: 'r', affectedNodeIds: [], dependsOn: [], risks: [],
    }],
  }).success, false);

  assert.equal(schema.safeParse({
    operations: [{
      operationId: 'op-1', kind: 'update_fields', nodeId: 'vol-1',
      fields: { chapterNodeIds: ['x'] },
      reason: 'r', affectedNodeIds: [], dependsOn: [], risks: [],
    }],
  }).success, false);

  assert.equal(schema.safeParse({
    operations: [{
      operationId: 'op-1', kind: 'add_node', nodeType: 'chapter', clientRef: 'c1',
      fields: { title: '章', summary: 's', volumeNodeId: 'vol-1' },
      reason: 'r', affectedNodeIds: [], dependsOn: [], risks: [],
    }],
  }).success, true);
});
