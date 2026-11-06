# Constrói a imagem e publica no Kubernetes local: .\scripts\deploy.ps1
# Reiniciar o app não troca o endereço público; só o pod do cloudflared faz isso.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Invoke-Checked {
  param([scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "Falhou: $Command" }
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
# Tag nova a cada publicação: com a mesma tag, o cluster reaproveita a imagem
# antiga. A mudança de tag também faz o pod reiniciar e reler as senhas.
$image = "to-do-list:$version-$(Get-Date -Format 'yyyyMMddHHmmss')"

Invoke-Checked { docker build -t $image . }
Invoke-Checked { kubectl apply -f k8s/namespace.yaml }

# As senhas ficam fora da imagem, só no Secret.
Invoke-Checked {
  kubectl -n todo-list create secret generic todo-usuarios `
    --from-file=users.json=server/users.json --dry-run=client -o yaml | kubectl apply -f -
}

$manifest = (Get-Content k8s/todo-list.yaml -Raw) -replace 'image: to-do-list:\S+', "image: $image"
Invoke-Checked { $manifest | kubectl apply -f - }

Invoke-Checked { kubectl -n todo-list rollout status deployment/todo --timeout=120s }
Invoke-Checked { kubectl -n todo-list rollout status deployment/cloudflared --timeout=120s }

$url = kubectl -n todo-list logs deployment/cloudflared |
  Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' |
  Select-Object -Last 1

if ($url) {
  Write-Output "No ar em: $($url.Matches[0].Value)"
} else {
  Write-Output 'Aguarde alguns segundos e rode este script de novo.'
}
