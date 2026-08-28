import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies the category tree. A three-level chain is enough to expose the
 * defect: the previous implementation only ever loaded relations one level
 * deep, so it either crashed or silently reported a node as childless.
 *
 * Requires `docker compose up -d`.
 */
describe('Category tree (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;

  // root -> middle -> leaf
  let rootId: number;
  let middleId: number;
  let leafId: number;

  const tree = async (id: number): Promise<any> => {
    const { body } = await http().get(`/categories/${id}/tree`).expect(200);
    return body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());
    const token = Date.now();

    const create = async (name: string, parentId?: number): Promise<number> => {
      const { body } = await http()
        .post('/categories')
        .send({ name, parentId })
        .expect(201);
      return body.id;
    };

    rootId = await create(`Root ${token}`);
    middleId = await create(`Middle ${token}`, rootId);
    leafId = await create(`Leaf ${token}`, middleId);
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it('returns the full descendant chain from the root', async () => {
    const root = await tree(rootId);

    expect(root.id).toBe(rootId);
    expect(root.parent).toBeUndefined();

    const middle = root.children.find((c: any) => c.id === middleId);
    expect(middle).toBeDefined();

    // The grandchild is the assertion that matters: loading one level deep
    // reported the middle node as having no children.
    expect(middle.children.map((c: any) => c.id)).toEqual([leafId]);
  });

  it('returns the full ancestor chain from a leaf', async () => {
    const leaf = await tree(leafId);

    expect(leaf.id).toBe(leafId);
    expect(leaf.children).toEqual([]);
    expect(leaf.parent.id).toBe(middleId);
    expect(leaf.parent.parent.id).toBe(rootId);
  });

  it('returns both directions from a node in the middle', async () => {
    const middle = await tree(middleId);

    expect(middle.parent.id).toBe(rootId);
    expect(middle.children.map((c: any) => c.id)).toEqual([leafId]);
  });

  it('answers for every node in the chain', async () => {
    for (const id of [rootId, middleId, leafId]) {
      await http().get(`/categories/${id}/tree`).expect(200);
    }
  });

  it('reports an unknown category as not found', async () => {
    await http().get('/categories/999999999/tree').expect(404);
  });
});
