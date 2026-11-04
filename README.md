# attacktree

> Nome provisório.

Um editor moderno de árvores de ataque e de decisão para modelar cenários adversos, tanto de segurança quanto de confiabilidade. A árvore mostra o que um atacante (ou uma falha) pode fazer, quais mitigações existem e onde elas deixam de funcionar.

## De onde veio a ideia

O projeto é inspirado no **Deciduous**, criado por Ryan Petrich e Kelly Shortridge (Team Bad, LLC):

- App: https://www.deciduous.app/
- Código-fonte: https://github.com/rpetrich/deciduous (GPL-2.0)
- Guia e post de lançamento: https://kellyshortridge.com/blog/posts/deciduous-attack-tree-app/

O Deciduous não recebe manutenção desde abril de 2024 (o último commit é de 20/04/2024). Gostamos da ideia e do formato. O que queremos é uma versão mais moderna, sofisticada e elegante.

### Conceitos que vêm do Deciduous

- **Tipos de nó:** `reality` (raiz implícita), `facts`, `attacks`, `mitigations` e `goals`.
- **Ligações:** cada nó declara de onde vem com `from:`.
- **Rótulos de aresta:** um texto qualquer pode rotular uma aresta. No Deciduous, `#yolosec` marca à mão um passo sem defesa. O attacktree mantém esse rótulo como texto comum e encontra sozinho os passos sem defesa (veja abaixo).
- **`backwards: true`:** a mitigação força o atacante a voltar e tentar outro ramo.
- **`implemented: false`:** a mitigação ainda não foi implementada.
- **`filter`:** mostra só os caminhos que passam pelos nós listados.
- **Fonte embutida:** o YAML original vai dentro do arquivo exportado (SVG/PNG/DOT), o que permite reabrir a árvore a partir da imagem.

### Relação com o código do Deciduous

Este projeto é uma **reimplementação independente**. Usamos o formato YAML e o comportamento do Deciduous como referência, mas não copiamos nem traduzimos o código dele, que é GPL-2.0. A meta é conseguir importar arquivos do Deciduous.

## Decisões iniciais (03/11/2026)

- **Edição:** o texto (YAML) e o canvas interativo ficam sincronizados nos dois sentidos.
- **Dados:** local-first e sem backend. As árvores ficam no navegador (IndexedDB) e podem ser importadas e exportadas como arquivos ou compartilhadas por link.
- **Stack:** React, TypeScript e Vite.
  - React Flow para o canvas.
  - CodeMirror 6 para o editor.
  - ELK.js para o layout, rodando num Web Worker.
- **Compatibilidade:** importar `.yaml` do Deciduous e arquivos SVG/PNG/DOT que tragam o YAML embutido.

## Status

Primeira versão funcional (v0.1):

- **Editor YAML (CodeMirror 6):**
  - autocomplete de ids em `from:` e `filter:`;
  - diagnósticos na linha, como referência a nó inexistente, id duplicado ou YAML inválido;
  - ids coloridos pelo tipo do nó.
- **Canvas interativo (React Flow + ELK):**
  - layout automático, com Reality no topo e os objetivos na base;
  - arestas ortogonais e arestas `backwards` roteadas sem atravessar nós.
- **Sincronização nos dois sentidos:**
  - clicar num nó seleciona o trecho correspondente no YAML, e mover o cursor no YAML seleciona o nó;
  - arrastar de um nó para outro cria a ligação;
  - uma seta selecionada mostra uma bolinha em cada ponta: arrastar uma delas para outro card move a ligação (ou use **From** e **To** no painel), e o YAML acompanha com rótulo, flags e comentários;
  - soltar no vazio cria o próximo nó (depois de um ataque vem uma mitigação, e vice-versa);
  - o painel lateral edita rótulo, tipo e id (renomear o id atualiza todas as referências), além de `backwards` e `implemented`;
  - Delete apaga e Ctrl+Z desfaz, inclusive no canvas;
  - as edições feitas no canvas alteram o próprio YAML e mantêm os comentários.
- **Reorganizar com o mouse:**
  - arrastar um nó fixa a posição dele, e as ligações acompanham o nó;
  - as posições ficam numa seção `positions:` no fim do YAML, que o Deciduous ignora, então vão junto em arquivos, links e exportações;
  - "Auto-arrange" volta ao layout automático, para todos os nós ou só para um (pelo painel lateral).
- **Lacunas encontradas sozinhas:**
  - um ataque sem mitigação implementada ganha o selo **No defense**;
  - um objetivo que o atacante alcança sem vencer nenhuma defesa ganha o selo **Open path**, e as setas desse caminho ficam vermelhas;
  - o painel lateral explica cada caso, e o cálculo usa a árvore inteira, mesmo com `filter` (`defenseGaps` em `src/model/analysis.ts`).
- **Destaque de caminho:** ao selecionar um nó, o que leva até ele e o que vem depois fica em evidência.
- **Local-first:**
  - várias árvores salvas no navegador (IndexedDB);
  - link de compartilhamento com a árvore inteira comprimida na URL, sem servidor.
- **Exportação e importação:**
  - SVG e PNG levam o YAML embutido e podem ser reimportados;
  - importa `.yaml` e também SVG/PNG/DOT exportados pelo Deciduous.
- **Só o diagrama:** um botão ao lado do título (ou Ctrl/⌘+\) esconde o editor YAML, e a escolha fica salva.
- **Interface:** tema claro e escuro (segue o sistema até a pessoa escolher um no botão) e layout para celular (abas YAML/Canvas).
- **Documentação em `/docs/`:**
  - conceitos, formato YAML completo, padrões de modelagem, método, referência do canvas e do editor, diagnósticos, atalhos e FAQ;
  - cada exemplo é desenhado ao vivo pelo motor do app e abre no editor com um clique;
  - a fonte única é `src/docs/guide.md`.
- **Feito para IA:**
  - `/llms.txt` e `/llms-full.txt` (gerado do `guide.md`), além de `/attacktree.schema.json`;
  - HTML estático em `/docs/` para crawlers que não executam JavaScript;
  - o botão "Copy for AI" copia um prompt com as regras do formato e a árvore atual;
  - colar a resposta de uma IA no editor remove os blocos de código Markdown, e o parser aceita as flags aninhadas que os modelos costumam gerar.

## LESIS

O attacktree é mantido pela [LESIS](https://lesis.lat) e funciona como canal de marketing dela:

- logo horizontal oficial no topo do app (também no celular) e da documentação;
- bloco "Built by LESIS" no topo da documentação, card "Talk to LESIS" e rodapé;
- "Made with attacktree by" seguido do logo nas imagens exportadas (SVG/PNG);
- menção no `llms.txt`;
- tipografia da LESIS: IBM Plex Sans no texto e IBM Plex Mono, em caixa alta e espaçada, nos rótulos e botões.

Os links levam `utm_source=attacktree&utm_medium=app|docs|export`, para medir de onde vem o tráfego. Os logos em `public/brand/` são os arquivos oficiais do [press kit](https://lesis.lat/press.html), apenas redimensionados: preto em fundo claro e branco em fundo escuro, sem alterar as cores.

## Desenvolvimento

```sh
npm install
npm run dev        # http://0.0.0.0:4100
npm test           # a suíte inteira (~1000 testes, jsdom)
npm run coverage   # com cobertura; falha abaixo de 100% de linhas/funções e 98% de branches
npm run build      # typecheck + build de produção em dist/
```

## Testes

A suíte cobre o modelo (parser e mutações, com testes de propriedade sobre vários documentos), o layout com o ELK real, as exportações (SVG validado com DOMParser e fonte embutida que volta intacta), o canvas com o React Flow real, o editor CodeMirror, a documentação e o App de ponta a ponta (IndexedDB falso, links de compartilhamento, importação e exportação, atalhos). Cada bug encontrado entra primeiro como um teste que falha. O CI roda o typecheck e a cobertura antes de publicar.

- Ambiente: `src/test/setup.ts` (jsdom, matchers do jest-dom, `fake-indexeddb` e as APIs de navegador que o jsdom não tem).
- Os testes ficam ao lado do código (`*.test.ts(x)`).
- Os poucos branches não cobertos são defensivos e inalcançáveis.

## Publicação (GitHub Pages)

Cada push em `main` roda os testes, gera o build e publica o site pelo workflow `.github/workflows/pages.yml`. O site fica em `https://attacktree.lesis.lat/` (domínio em `public/CNAME`, DNS na Cloudflare com CNAME para `lesis-lat.github.io` em modo DNS only), e a documentação em `/docs/`.

- Os caminhos do app seguem o `base` do Vite. O workflow passa `BASE_PATH` com o caminho que o GitHub Pages informa, então um domínio próprio funciona sem mudar o código.
- Para testar localmente com o mesmo caminho: `BASE_PATH=/attacktree/ npm run build && BASE_PATH=/attacktree/ npm run preview`.
- Ativação, feita uma vez: em **Settings → Pages**, escolha **GitHub Actions** em **Source**.

## Segurança

Vulnerabilidades: veja [SECURITY.md](SECURITY.md); o reporte é privado, pela aba Security.

- Pull requests passam por `.github/workflows/ci.yml`: audit, typecheck, testes com cobertura e build.
- `.github/workflows/codeql.yml` analisa o TypeScript e os workflows.
- `.github/dependabot.yml` abre as atualizações semanais. Antes de mesclar um PR do Dependabot, confira se o CI ficou verde.
- O build põe uma Content-Security-Policy em `<meta>` (veja `CSP` em `vite.config.ts`): scripts só da própria origem, sem inline e sem `eval`. Ela não vale em `npm run dev`, porque o Vite injeta scripts inline para o hot reload. Ao adicionar algo que carregue recursos de outra origem, ajuste a política e confira no `npm run preview`.

## Licença

A definir.
