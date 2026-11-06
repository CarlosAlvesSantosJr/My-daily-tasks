# Minhas Tarefas

App web e PWA, responsivo para celular, com login:

- **Lista e Calendário:** tarefas privadas, cada usuário vê só as próprias.
- **Mercado:** lista compartilhada entre os usuários, atualizada em tempo real, com notificação no celular mesmo com o app fechado.

## Publicar no Kubernetes

Precisa do Docker Desktop com o Kubernetes ligado. Na pasta do projeto, em PowerShell:

```
.\scripts\deploy.ps1
```

O script constrói a imagem, publica no namespace `todo-list` e mostra o endereço público. Use o mesmo comando para publicar atualizações. Publicar de novo não troca o endereço.

### Descobrir o endereço público

O túnel rápido da Cloudflare não precisa de conta, mas **o endereço muda sempre que o pod `cloudflared` reinicia**, o que inclui reiniciar o computador ou o Docker Desktop. Para ver o endereço atual:

```
kubectl -n todo-list logs deployment/cloudflared | Select-String trycloudflare
```

Quando o endereço muda, o app instalado no celular para de funcionar. É preciso abrir o endereço novo, instalar de novo, entrar e ativar os avisos outra vez. Um endereço fixo exige uma conta na Cloudflare e um domínio próprio, com um túnel nomeado no lugar do túnel rápido em [k8s/todo-list.yaml](k8s/todo-list.yaml).

### Limitações

- O app fica no ar só enquanto o computador e o Docker Desktop estiverem ligados.
- Fica em uma réplica só, de propósito: os dados são arquivos e o tempo real roda em memória.

## Instalar no celular

- **Android (Chrome):** abra o endereço e use o botão **Instalar app** na aba Mercado, ou o menu do navegador.
- **iPhone (Safari):** toque em Compartilhar e em **Adicionar à Tela de Início**. No iPhone, as notificações só funcionam com o app instalado e com iOS 16.4 ou mais novo.

Depois, na aba Mercado, toque em **Ativar avisos**. Cada usuário precisa fazer isso no próprio aparelho. A primeira ativação pode levar cerca de 30 segundos.

## Usuários e senhas

As senhas ficam em `server/users.json`, apenas como hash. Esse arquivo não vai para o Git nem para a imagem; no Kubernetes ele fica em um Secret. Depois de clonar o repositório, crie os usuários antes de rodar o app. Para criar um usuário ou trocar uma senha:

```
node scripts/set-password.js <nome> <nova-senha>
.\scripts\deploy.ps1
```

Com o app na internet, prefira senhas longas: o limite de tentativas atrasa quem tenta adivinhar uma senha de 4 dígitos, mas não impede.

## Dados e backup

No Kubernetes, tudo fica no volume `todo-dados`, montado em `/data`: um arquivo de tarefas por usuário, a lista de mercado, as sessões e as chaves de notificação.

O volume é apagado junto com o namespace, e também se o Kubernetes do Docker Desktop for reiniciado de fábrica. Para copiar os dados para o computador:

```
$pod = kubectl -n todo-list get pod -l app=todo -o name
kubectl -n todo-list cp "$($pod.Split('/')[1]):/data" backup
```

## Rodar sem Kubernetes

Precisa do Node.js 20 ou mais novo.

```
npm install
npm start
```

Neste modo os dados ficam na pasta `data/`, separados dos dados do Kubernetes. Notificações e instalação como app só funcionam em `localhost` ou com HTTPS.

## Testes

```
npm test
```
