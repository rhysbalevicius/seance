output "instance_id" {
  value = aws_instance.box.id
}

output "private_ip" {
  description = "VPC-internal IP. You will never use it day to day; the box is reached via Tailscale."
  value       = aws_instance.box.private_ip
}

output "key_name" {
  description = "Name of the EC2 key pair generated for this box."
  value       = aws_key_pair.box.key_name
}

output "ssh_public_key" {
  description = "Public half of the box's key pair, in authorized_keys format."
  value       = tls_private_key.box.public_key_openssh
}

output "ssh_private_key" {
  description = "Private half of the box's key pair. Save it to disk; it also lives in terraform state, so keep state private."
  value       = tls_private_key.box.private_key_openssh
  sensitive   = true
}

output "next_step" {
  value = "Watch bootstrap: the box appears in your tailnet as '${var.box_name}' within ~3 min; then `ssh dev@${var.box_name}` and `tail -f /var/log/seance-bootstrap.log`."
}
