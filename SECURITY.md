# Segurança

*To report a vulnerability, use GitHub's private reporting: Security → Report a vulnerability. Please do not open a public issue.*

## Como reportar

Use o reporte privado do GitHub: aba **Security** → **Report a vulnerability**. Só os mantenedores veem o relato, e a conversa e a correção acontecem ali. Não abra issue pública para vulnerabilidades.

Ajuda muito incluir:

- o que um atacante consegue fazer;
- os passos para reproduzir: um link `#tree=`, um YAML, um SVG ou PNG exportado, o que for;
- navegador e versão.

Respondemos em até 5 dias úteis. Quem reporta recebe crédito no aviso de segurança, a não ser que prefira ficar anônimo.

## Escopo

O attacktree roda inteiro no navegador. Não há servidor nem contas: as árvores ficam no IndexedDB do navegador, e um link compartilhado leva a árvore no fragmento `#`, que nunca vai para o servidor.

Interessa principalmente:

- executar script, ou ler ou alterar as árvores de alguém, a partir de algo que um atacante controla: um link compartilhado, um YAML importado, ou um SVG ou PNG exportado e aberto de novo;
- um conteúdo desse tipo que trave ou derrube a aba de quem o abre;
- um export que vaze algo além da própria árvore;
- falhas nos workflows do GitHub Actions ou na cadeia de dependências.

Fora do escopo:

- ataques que exigem acesso ao computador ou ao navegador da vítima;
- headers que o GitHub Pages não permite configurar (por exemplo `frame-ancestors` e `X-Frame-Options`). A Content-Security-Policy vai num `<meta>`.

## O que já existe

- Uma Content-Security-Policy no build: só scripts da própria origem, sem scripts inline e sem `eval`.
- Links compartilhados limitados a 4 MB descomprimidos.
- O CodeQL analisa o código e os workflows a cada push e pull request, e uma vez por semana.
- O Dependabot mantém as dependências e as Actions atualizadas.
- Todo pull request roda `npm audit`, typecheck, os testes com o gate de cobertura e o build.
