1. aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
3. VERSION=<package.json> npm run build-docker:massiveinfinity
2. docker tag massiveinfinity/uptime-kuma:<version>-slim public.ecr.aws/<repo_id>/uptimekuma:<version>-slim
3. docker push public.ecr.aws/<repo_id>/uptimekuma:<version>-slim
