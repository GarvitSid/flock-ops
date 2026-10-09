const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../app');

describe('Flock Energy API - Test Suite', () => {
    let server;
    let baseUrl;

    before(async () => {
        await new Promise((resolve) => {
            server = http.createServer(app);
            // Listen on random available port
            server.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test('GET /health returns 200 and healthy status', async () => {
        const res = await fetch(`${baseUrl}/health`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.status, 'ok');
        assert.equal(data.service, 'flock-energy-api');
        assert.equal(typeof data.uptime, 'number');
        assert.ok(data.timestamp);
    });

    test('GET / redirects to /docs', async () => {
        const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/docs');
    });

    test('GET /docs/ serves Swagger UI documentation', async () => {
        const res = await fetch(`${baseUrl}/docs/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('Swagger UI') || html.includes('swagger'));
    });

    test('GET /unknown-route returns 404 JSON', async () => {
        const res = await fetch(`${baseUrl}/some-random-route`);
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.ok(data.error);
        assert.ok(data.error.includes('Route not found'));
    });

    test('CORS headers are present on responses', async () => {
        const res = await fetch(`${baseUrl}/health`, {
            headers: { Origin: 'https://example.com' }
        });
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
});
