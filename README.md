# Cérebro Babel

Seu computador como um cérebro, no estilo Obsidian. O centro é o computador; dele saem as
**linhas neurais**, que são as pastas da home. Dentro de cada pasta os arquivos ficam ligados
em ordem alfabética por um **fio que pulsa**. Passe o mouse sobre um nó para ver a prévia.

O app **só lê o disco**. Não move, não renomeia e não apaga nada, e mostra o disco ao vivo.

## Requisitos

- **Node.js** 18+
- **poppler** (para previews de PDF):
  - Linux: `sudo apt install poppler-utils` ou `sudo dnf install poppler-utils`
  - Mac: `brew install poppler`
- **Chrome/Chromium** (para modo app)

## Abrir

- Menu de aplicativos, ou o ícone **Cérebro Babel** na Área de trabalho
- ou `./abrir.sh`, que abre o Chrome em modo app em http://127.0.0.1:3077

O servidor sobe com o login (serviço systemd de usuário):

```sh
systemctl --user status cerebro-babel     # estado
systemctl --user restart cerebro-babel    # depois de mudar o server.js
journalctl --user -u cerebro-babel -f     # logs
```

## Uso

| Ação | Efeito |
|---|---|
| clique numa pasta | **foco**: a câmera voa até ela, o resto esmaece e os filhos viram uma **dupla hélice de DNA em pé** |
| duplo clique numa pasta | entra nela dentro do próprio Cérebro (foco + DNA). Não abre mais o Thunar |
| clique na pasta em foco | recolhe e volta um nível |
| clique num arquivo | aproxima a câmera e destaca o rótulo dele no DNA (a hélice para de girar) |
| duplo clique num arquivo | **visor grande** no app: imagem, vídeo, áudio, PDF página a página, texto. O botão "Abrir no aplicativo padrão" chama o `xdg-open` só quando você clicar nele |
| passar o mouse | **card HUD**: breadcrumb do caminho, metadados em fonte mono, medidores, contagem por tipo (pastas) e prévia (arquivos), com linha-guia até o nó |
| nó "+N mais" | carrega o resto das pastas com mais de 150 itens |

### O DNA

Na pasta em foco, cada arquivo é um ponto numa das duas fitas; cada par de arquivos é ligado por uma ponte com
pulsos. Os rótulos (nome, tipo, tamanho, data) ficam presos aos pontos, virados para a câmera. Com muitos arquivos
aparecem os mais próximos sem se sobrepor; o resto aparece ao passar o mouse. Sair do foco devolve o layout normal.

### Teclado (fora de campos de texto)

| Tecla | Efeito |
|---|---|
| `Espaço` | voltar ao cérebro (centro) |
| `Q` | voltar: vai para onde você estava antes; sem histórico, sobe para a pasta pai |
| `E` | refazer: desfaz o último `Q`, como o "avançar" do navegador |
| `/` | buscar (abre o painel se estiver recolhido) |
| `Esc` | fecha o visor ou o card |

Cliques, duplo clique, busca e a trilha do topo entram no mesmo histórico.

### Painel de controle (canto inferior esquerdo)

Reúne a busca, "voltar ao cérebro", voltar/refazer, zoom + e −, tamanho dos nós + e −, a legenda de cores e os atalhos.
O botão de seta recolhe o painel num botão pequeno; o estado fica guardado no navegador (`localStorage`).
No topo, a **trilha** mostra onde você está (`Cérebro › pasta › subpasta`); clicar num trecho vai para ele.

Cores: pasta azul, imagem ciano, vídeo magenta, áudio verde, documento âmbar, código violeta, compactado ouro.

## Estrutura

- `server.js`: servidor Node sem dependências, só em `127.0.0.1:3077`. Endpoints: `/api/list`, `/api/search`,
  `/api/thumb`, `/api/text` (`full=1` para o visor, até 512 KB), `/api/stats` (contagem por tipo e volume de uma pasta),
  `/api/pdfinfo` e `/api/pdfpage` (página do PDF em 1600 px, via `pdftoppm`), `/api/media` (com Range) e
  `/api/open` (POST, chama `xdg-open`; o app só usa no botão do visor).
- `src/main.js`: frontend (3d-force-graph + three + UnrealBloomPass). `npm run build` gera `public/app.js`
  e copia as fontes Exo 2 e Inter para `public/fonts/`. Nada vem de CDN.
- Cache das prévias: `~/.cache/cerebro-babel/` (pode apagar à vontade).

## Segurança

- Escuta só em 127.0.0.1 e recusa qualquer `Host` que não seja `127.0.0.1:3077` ou `localhost:3077` (contra DNS rebinding).
- Todo caminho é resolvido com `realpath` e precisa ficar dentro da home. Pastas ocultas (`.ssh`, `.config`…)
  e symlinks que apontam para fora da home são recusados.
- `/api/open` exige POST JSON com o cabeçalho `X-Cerebro: 1`, então outros sites não conseguem chamar.
- Ignora ocultos, `node_modules`, `__pycache__` e venvs Python.

## Testes

```sh
npm test    # sobe um servidor na porta 3078 com CEREBRO_NO_OPEN=1 (nunca chama xdg-open)
```

Roda com o Playwright em `~/.npm/_npx/…` e o Google Chrome do sistema. Cobre segurança, rede, painel
(recolher/expandir/lembrar), card HUD, duplo clique em pasta sem `/api/open`, foco que esmaece, DNA em pé com
rótulos, visor, Espaço/Q/E, busca e movimento reduzido. Os screenshots (1440×900) ficam em `prints/` (a v2 usa o
prefixo `v2-`).

No Chrome headless com swiftshader (~1 quadro por segundo) as transições CSS ficam pendentes para sempre, então o
teste desliga só as transições. No navegador de verdade elas rodam normalmente.
