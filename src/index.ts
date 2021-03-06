import _ from 'lodash';
import * as mime from 'mime-types';

// @ts-ignore
import { base64ArrayBuffer } from "./base64ArrayBuffer";
import { config as configSrc } from './config'
import sanitize from 'sanitize-filename'

let config = configSrc;


// https://stackoverflow.com/questions/1349404/generate-random-string-characters-in-javascript
function makeId(len: number): string {
  let result = '';
  for (let i = 0; i < len; i++) {
    result += _.sample(config.characters)
  }
  return result;
}

function getChr(num: number) {
  return config.characters[Math.floor(num) % config.charLen];
}

async function checksum(s: string) {
  let text = new TextEncoder().encode(s);
  let padding = new Uint8Array(config.paddingLen - text.length);
  let value = Uint8Array.from([...config.secret, ...text, ...padding]);

  let digest = await crypto.subtle.digest({ name: 'SHA-256' }, value);
  return new Uint8Array(digest)[0];
}

async function generateId(): Promise<string> {
  let date = Date.now() - config.dateOffset;
  let dateCode = getChr(date / config.dateRotation);
  let randCode = makeId(config.idLen - 2);
  let checkCode = getChr(await checksum(randCode));
  return dateCode + checkCode + randCode;
}

async function fetchGitlabFile(fileName: string): Promise<Response> {
  let fileNameUrl = encodeURIComponent(fileName);
  let filesUrl = `https://gitlab.com/api/v4/projects/${config.project}/repository/files/${fileNameUrl}/raw?ref=${config.branch}`;
  // filesUrl = `https://httpbin.org/anything/${filesUrl}`;
  let resp = await fetch(filesUrl, {
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': config.token
    }
  });
  // return resp;
  return new Response(resp.body, { status: resp.status });
}

async function fetchGitlabCreateCommit(actions: Array<any>, commitMessage: string) {
  let url = `https://gitlab.com/api/v4/projects/${config.project}/repository/commits`;
  let data = {
    branch: config.branch,
    actions: actions,
    commit_message: commitMessage
  }

  let resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': `${config.token}`
    },
    body: JSON.stringify(data)
  });

  return new Response(resp.body, { status: resp.status });
}

async function validatePath(path: string) {
  let rx = /^\/?([a-z0-9]+)([.][a-z0-9]+)?\/?$/i
  let rx2 = /^\/?([a-z0-9]+)\/([a-z0-9-_.!~*'()#%]+)$/i
  let match = rx.exec(path) || rx2.exec(path);

  if (!match) {
    return null;
  }

  let id = match[1];
  if (id.length != config.idLen) {
    return null;
  }

  if (id[1] != getChr(await checksum(id.slice(2)))) {
    return null;
  }

  return match;
}

function idToRepoFile(id: string) {
  return `${id[0]}/${id[1]}/${id.slice(2)}`;
}

async function createFileAction(id: string, file: string | Blob, base64: boolean = false) {
  let filename = idToRepoFile(id);

  let payload: {[key: string]: string} = {
    action: 'create',
    file_path: filename
  }

  if (_.isString(file)) {
    payload['content'] = file;
  } else {
    if (base64) {
      payload.content = await file.text()
    } else {
      payload.content = base64ArrayBuffer(await file.arrayBuffer());
    }
    payload['encoding'] = 'base64';
  }
  return payload;
}

function createPathFromFile(id: string, fileName: string = '') {
  let ext = '';
  let extIndex = fileName.lastIndexOf('.');
  if (extIndex >= 0) {
    ext = fileName.slice(extIndex + 1);
  }

  if (ext && ext in mime.types) {
    return `/${id}.${ext}`;
  } else {
    return `/${id}`;
  }
}


async function handleRequest(event: FetchEvent, request: Request): Promise<Response> {
  let url = new URL(request.url);
  let path = url.pathname;
  let host = url.hostname;
  let cache = caches.default;

  // Override hostname based on url
  config = _.defaults(config.overrides[host], config)

  let pathBegin = path.split('/')[1];
  let endpointType = config.uploadKeys[pathBegin]

  if (request.method == 'GET' || request.method == 'HEAD') {
    let match = await validatePath(path);

    // Validate path
    if (!match) {
      return new Response(match, { status: 404 });
    }

    // Check content type
    const ext = match[2] || '.txt';
    console.log(ext)
    let contentType = mime.contentType(ext);
    if (contentType === false) {
      contentType = 'application/octet-stream';
    }

    // Handle caching key
    let file = match[1];
    let cacheKey = new Request(new URL(`/${file}`, url.toString()).toString(), {
      headers: request.headers
    });

    // Handle file name
    let downloadName = null;
    if (!ext.startsWith('.')) {
      downloadName = sanitize(decodeURIComponent(ext));
    }

    // handle headers
    let contentHeaders: HeadersInit = {
      'content-type': contentType
    }

    let cacheHeaders: HeadersInit = {
      'cache-control': 'public, max-age=31536000'
    }

    let securityHeaders: HeadersInit = {
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; script-src 'none'; style-src 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Access-Control-Allow-Origin': url.origin
    }

    if (!_.isNull(downloadName)) {
      contentHeaders['content-disposition'] = `attachment; filename="${downloadName}"`;
    }

    // Return cache if found
    let resp = await cache.match(cacheKey);
    if (resp) {
      console.log(`cache hit! match=${match[0]}`);
      let headers = new Headers(resp.headers);
      headers.delete('content-disposition');
      Object.entries(contentHeaders).forEach(
          ([k, v]) => headers.set(k, v));
      return new Response(resp.body, {
        headers: headers,
        status: resp.status
      });
    }

    // Fetch from origin
    let fileName = idToRepoFile(match[1]);
    resp = await fetchGitlabFile(fileName);

    if (resp.ok) {
      resp = new Response(resp.body, {
        headers: { ...contentHeaders, ...cacheHeaders, ...securityHeaders },
        status: resp.status
      });
    } else {
      resp = new Response(null, {
        headers: { ...cacheHeaders, ...securityHeaders },
        status: 404
      });
    }

    event.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  if (endpointType === undefined && !config.uploadAllowInsecure) {
    throw 500;
  }
  let ip = request.headers.get('cf-connecting-ip');

  if (endpointType == 'waaai') {
    return handleWaaai(request, config.waaai);
  }

  if (request.method == 'POST') {
    let formData = await request.formData();
    let actions = [];
    let urls = [];

    for (let [name, content] of formData.entries()) {
      let id = await generateId();
      let action = await createFileAction(id, content, endpointType == 'base64');
      if (_.isEmpty(action.content)) {
        continue;
      }
      actions.push(action);
      let fileName = (content instanceof File && content.name) || name || '';
      let filePath = createPathFromFile(id, fileName);
      urls.push(new URL(filePath, url.toString()).toString())
    }

    if (_.isEmpty(actions)) throw 400;

    let resp = await fetchGitlabCreateCommit(actions, `Created by ${ip}`);
    if (resp.ok) {
      return new Response(urls.join('\n'), { status: resp.status });
    } else {
      return new Response(null, { status: resp.status });
    }
  }

  if (request.method == 'PUT') {
    let fileName = _.last(path.split('/'));
    let data = await request.blob();

    let id = await generateId();
    let actions = [await createFileAction(id, data, endpointType == 'base64')];
    let filePath = createPathFromFile(id);
    if (!_.isEmpty(fileName)) {
      filePath += '/' + fileName;
    }
    let newUrl = new URL(filePath, url.toString()).toString();

    let resp = await fetchGitlabCreateCommit(actions, `Uploaded by ${ip}`);
    if (resp.ok) {
      return new Response(newUrl, { status: resp.status });
    } else {
      return new Response(null, { status: resp.status });
    }
  }

  throw null;
}

async function handleWaaai(request: Request, config: any) {
  const contentType = request.headers.get('content-type') || '';

  if (request.method != 'POST') {
    return new Response(null, { status: 500 });
  }

  let body: any = {}
  if (contentType.includes('application/json')) {
    body = await request.json();
  } else if (contentType.includes('form')) {
    const formData = await request.formData();
    for (const entry of formData.entries()) {
      body[entry[0]] = entry[1];
    }
  }

  if (Object.keys(body).length == 0) {
    return new Response(null, { status: 500 });
  }

  let resp = await fetch(config.api, {
    headers: {
      'content-type': 'application/json',
      'Authorization': `API-Key ${config.apikey}`
    },
    method: 'POST',
    body: JSON.stringify(body)
  })

  let shortUrl = null;
  if (resp.status == 200) {
    let data: any = await resp.json();
    console.log(data);
    shortUrl = data['data']['link']
  }

  return new Response(shortUrl, { 'status': resp.status })
}

addEventListener('fetch', event => {
  return event.respondWith(
      handleRequest(event, event.request)
          .catch(e => {
            if (_.isNumber(e)) {
              return new Response(null, { status: e })
            } else {
              console.log(e.stack);
              return new Response(null, { status: 500 })
            }
          }));
});
