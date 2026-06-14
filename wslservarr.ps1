param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

& "$PSScriptRoot\servarr.ps1" @Args
exit $LASTEXITCODE
