# Cérebro Babel

Um projeto **Supabase** como um cérebro, no estilo Obsidian. O centro é o projeto (hoje o **Reino**,
`fxlansnepokjxdikxocb`); dele saem as **linhas neurais**: um schema por linha, mais **Edge Functions** e **Buckets**.
Dentro de cada schema ficam tabelas, views e funções; dentro de cada tabela, as linhas. Passe o mouse sobre um nó
para ver o card.

O app **só lê**. Todo SQL vai com `read_only: true` pela Management API (a mesma que o MCP do Supabase usa) e
qualquer método que não seja GET é recusado (a única exceção é o áudio da voz, `POST /api/ouvir`, que vai para o Whisper e não toca no banco). Não escreve, não altera schema, não chama nada no computador.

## Requisitos

- **Node.js** 18+ (usa `fetch` nativo)
- **Chrome/Chromium** (para o modo app)
- Token do Supabase CLI em `~/.supabase/access-token` (ou a variável `SUPABASE_ACCESS_TOKEN`)

## Abrir

- Menu de aplicativos, ou o ícone **Cérebro Babel** na Área de trabalho
- ou `./abrir.sh`, que abre o Chrome em modo app em http://127.0.0.1:3077

O servidor sobe com o login (serviço systemd de usuário):

```sh
systemctl --user status cerebro-babel     # estado
systemctl --user restart cerebro-babel    # depois de mudar o server.js ou as fontes
journalctl --user -u cerebro-babel -f     # logs
```

Outro projeto: `CEREBRO_PROJECT=<ref> node server.js` (o token precisa enxergar esse projeto).

## O que vira o quê

| No grafo | Vem de |
|---|---|
| centro | o projeto (nome, região, ref) |
| linha neural | cada schema (`public`, `auth`, `storage`…), mais **Edge Functions** e **Buckets** |
| tabela / view | `pg_class`; o card mostra colunas, chave primária, RLS, políticas e nº de gatilhos |
| função | `pg_proc`; duplo clique mostra o SQL (`pg_get_functiondef`) |
| linha de tabela | `to_jsonb(t)` ordenado pela chave primária, 150 por página (nó "+N mais" carrega o resto) |
| Edge Function | lista da Management API; o visor mostra os metadados e o `index.ts` de `~/Downloads/Reino/supabase/functions` |
| arquivo de bucket | `storage.objects`; imagens saem pelo servidor (a chave do storage nunca vai ao navegador) |
| fio dourado entre tabelas | chave estrangeira, quando as duas tabelas estão no grafo |

Colunas com nome de segredo (`password`, `token`, `secret`, `hash`, `api_key`, `encrypted_*`…) aparecem como
`•••••• (oculto)` no card, no visor e na busca, e o base64 de imagens vira `data:image/…;base64,… (N KB)`.

## Uso

| Ação | Efeito |
|---|---|
| clique num schema/tabela | **foco**: a câmera voa até ele, o resto esmaece e os filhos viram uma **dupla hélice de DNA em pé** |
| duplo clique numa pasta | entra nela dentro do próprio Cérebro |
| clique na pasta em foco | recolhe e volta um nível |
| clique numa linha/função | aproxima a câmera e destaca o rótulo |
| duplo clique numa linha/função | **visor grande**: registro em JSON (com a foto, se houver), SQL da função ou código da Edge Function. O botão "Abrir no painel do Supabase" abre o item no dashboard, só quando você clica |
| passar o mouse | **card HUD** com metadados, medidores, gráfico por tipo e linha-guia até o nó |
| botão/tecla "Abrir Reino" | abre **tudo** — schemas, tabelas, views, funções, Edge Functions, buckets, as linhas de cada tabela e os arquivos de cada bucket — e puxa cada pasta para um ponto de uma esfera, um "país" por seção do cérebro. Não é um mapa pintado: o mundo é feito só das próprias pastas abertas, cada uma com a sua bolinha e a cor do seu tipo |
| botão/tecla "Fios" | troca a curvatura dos fios que ligam as pastas entre três estilos: Neural (o padrão), Retos e Em arco; a escolha fica guardada |

Teclado (fora de campos de texto): `Espaço` volta ao cérebro, `Q` volta, `E` refaz, `/` busca, `R` abre o Reino,
`X` fecha tudo, `F` liga/desliga o fundo quântico, `W` troca o estilo dos fios, `Esc` fecha.

A **busca** acha tabelas, views, funções e Edge Functions pelo nome, e registros de `public` e `privado` pelo
conteúdo (só entra quem tem chave primária). Cores: schema azul, tabela ciano, view violeta, função âmbar,
linha verde, Edge Function magenta, bucket ouro, arquivo do storage rosa.

## Voz (estilo Jarvis)

**Segure Espaço** (ou o reator azul no rodapé), fale e solte. Um toque rápido no Espaço continua voltando ao cérebro.

| Etapa | Serviço (grátis) |
|---|---|
| ouvir | Groq **Whisper** `whisper-large-v3-turbo` (`POST /api/ouvir`) |
| entender | Groq `openai/gpt-oss-120b` decide: abrir tabela, buscar, consultar (SQL) ou voltar ao início (`/api/perguntar`) |
| responder | **edge-tts**, voz neural `pt-BR-AntonioNeural` um pouco mais grave, com eco curto no navegador (`/api/voz`); sem internet cai na voz do sistema |

Exemplos: "quantos cadastros temos?", "qual foi o último cadastro e de que cidade?", "me mostra a tabela de perfis",
"procura o Marcelo", "volta pro início". No fim ele diz **"Aqui está, senhor."**

O que sai da máquina: o áudio e a pergunta (Groq) e os **nomes** de tabelas e colunas (sem as colunas de segredo).
As linhas do banco não saem: o SQL roda aqui, `read_only`, um único SELECT limitado a 50 linhas, e o resultado só
vai para a tela e para a frase falada (o texto da frase passa pelo edge-tts). A chave vem de `GROQ_API_KEY` ou da linha
`export GROQ_API_KEY=` do `~/.bashrc`. Trocar: `CEREBRO_LLM`, `CEREBRO_WHISPER`, `CEREBRO_VOZ`. Código em
`assistente.js` (servidor) e `src/voz.js` (HUD, gravação e voz).

## Estrutura

- `server.js`: servidor Node sem dependências, só em `127.0.0.1:3077`. Endpoints, todos GET: `/api/info`,
  `/api/list`, `/api/search`, `/api/stats`, `/api/text` (`full=1` para o visor) e `/api/media`.
- `fonte-supabase.js`: fonte de dados (Management API, cache de 20 s, no máximo 4 chamadas simultâneas).
- `fonte-teste.js`: banco falso em memória com o mesmo formato; `CEREBRO_FONTE=teste` a ativa.
- `comum.js`: erro HTTP, lista de colunas secretas, mascaramento e caminhos.
- `src/main.js`: frontend (3d-force-graph + three + UnrealBloomPass). `npm run build` gera `public/app.js`
  e copia as fontes Exo 2 e Inter para `public/fonts/`. Nada vem de CDN.

O caminho de um item é a lista de segmentos separados por `/`, cada um com `encodeURIComponent`:
`public/cadastros/<id>`, `@edge/reino-login`, `@buckets/avatares/u1%2Favatar.png`.

## Segurança

- Escuta só em 127.0.0.1 e recusa qualquer `Host` que não seja `127.0.0.1:3077` ou `localhost:3077` (contra DNS rebinding).
- O token do Supabase fica só no servidor. O navegador nunca o vê, nem a chave do storage.
- Só GET; SQL sempre `read_only: true`; nomes de schema, tabela e valores entram no SQL escapados.
- Imagens de linhas e do storage saem com `Content-Security-Policy: sandbox`.
- Permissão negada do Supabase (ex.: `vault.decrypted_secrets`) vira 403 amigável.

## Testes

```sh
npm test    # sobe um servidor na porta 3078 com CEREBRO_FONTE=teste (banco falso, não toca no Supabase)
```

Roda com o Playwright em `~/.npm/_npx/…` e o Google Chrome do sistema: 67 verificações de segurança, rede, painel,
card HUD, foco, DNA, chaves estrangeiras, colunas/RLS, visor, segredos ocultos, Edge Functions, buckets,
Espaço/Q/E, busca e movimento reduzido. Prints em `prints/` (prefixo `v3-`).

No Chrome headless com swiftshader (~1 quadro por segundo) as transições CSS ficam pendentes para sempre, então o
teste desliga só as transições.
