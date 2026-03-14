param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $true
}

& $Command @Arguments

if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}

if (-not $?) {
  exit 1
}
